// K043/K046 · Infrastructure: incidencias en PostgreSQL (ADR 0020 y 0021). No decide permisos ni
// transiciones: ejecuta bajo el bloqueo del lote lo que Application pide.
import type { EstablishmentIncidentView, IncidentDispatchRepository, IncidentReport, IncidentRepository, IncidentVersionResult,
  IncidentView } from '../../application/incidents/ports.js'
import type { IncidentStatus, PublishedIncidentStatus } from '../../domain/incidents.js'
import type { LotStatus } from '../../domain/lots.js'
import type { IncidentNotice } from '../../domain/notifications.js'
import { closeLot } from './lot-closure.js'
import { lotReconciledSql } from './waitlist-queue.js'
import { appendEvent } from './outbox.js'
import { lockIntent, lockLot } from './lot-lock.js'
import { withTransaction } from './pool.js'
import type { Pool, PoolClient } from './pool.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
const versionColumns = `i.public_id::text AS "incidentId", v.version, v.status, v.reason, v.instructions,
  ${iso('v.created_at')} AS "publishedAt", v.close_lot AS "closeLot", v.lot_closed AS "lotClosed"`

/**
 * Versiones de la incidencia `i`, con el correo de quien publicó cada una y sus avisos por
 * destinatario: sin evento o sin aviso aún, aviso sin leer y aviso leído (K046).
 */
const versionsJson = `COALESCE((SELECT json_agg(json_build_object('version', v.version, 'status', v.status, 'reason', v.reason,
    'instructions', v.instructions, 'publishedAt', ${iso('v.created_at')}, 'closeLot', v.close_lot, 'lotClosed', v.lot_closed,
    'publishedBy', u.email, 'recipientCount', n.total,
    'notices', json_build_object('pending', n.pending, 'generated', n.generated, 'read', n.read)) ORDER BY v.version)
  FROM public.incident_versions v JOIN public.users u ON u.id = v.published_by
  CROSS JOIN LATERAL (SELECT count(*)::int AS total,
      count(*) FILTER (WHERE m.id IS NULL)::int AS pending,
      count(*) FILTER (WHERE m.id IS NOT NULL AND m.read_at IS NULL)::int AS generated,
      count(*) FILTER (WHERE m.read_at IS NOT NULL)::int AS read
    FROM public.incident_recipients r
    LEFT JOIN public.notifications m ON m.event_id = r.outbox_event_id AND m.user_id = r.user_id
    WHERE r.incident_id = v.incident_id AND r.version = v.version) n
  WHERE v.incident_id = i.id), '[]'::json)`
const incidentColumns = `i.public_id::text AS id, i.status, i.version, i.report_reason AS "reportReason",
  ${iso('i.created_at')} AS "reportedAt", ${versionsJson} AS versions`
const PAGE_SIZE = 20

type Db = Pick<PoolClient, 'query'>
async function member(db: Db, userId: string, establishmentId: string) {
  return (await db.query('SELECT 1 FROM public.memberships WHERE user_id = $1 AND establishment_id = $2',
    [userId, establishmentId])).rowCount === 1
}

/**
 * Se ejecuta con el lote bloqueado, en la transacción que crea el compromiso: quien se
 * compromete con un lote pasa a ser destinatario de la última versión de cada incidencia
 * vigente. Publicar compite por el mismo bloqueo y la clave primaria impide duplicados.
 */
export async function incorporateIncidentRecipient(client: PoolClient, lotId: string, userId: string, at: Date): Promise<void> {
  await client.query(
    `INSERT INTO public.incident_recipients (incident_id, version, user_id, relation, created_at)
     SELECT i.id, i.version, $2, 'committed', $3 FROM public.incidents i
     WHERE i.lot_id = $1 AND i.status IN ('open', 'following')
     ON CONFLICT DO NOTHING`, [lotId, userId, at])
}

/** Personas con compromisos históricos, operadores actuales y destinatarios de versiones previas. */
async function fixRecipients(client: PoolClient, incidentId: string, version: number, lotId: string, at: Date): Promise<void> {
  await client.query(
    `INSERT INTO public.incident_recipients (incident_id, version, user_id, relation, created_at)
     SELECT $1::bigint, $2::integer, link.user_id, min(link.relation), $4::timestamptz FROM (
       SELECT c.user_id, (CASE WHEN c.status = 'delivered' THEN 'received' ELSE 'committed' END)::public.incident_recipient_relation AS relation
         FROM public.commitments c WHERE c.lot_id = $3
       UNION ALL SELECT w.user_id, 'committed'::public.incident_recipient_relation FROM public.waitlist_entries w WHERE w.lot_id = $3
       UNION ALL SELECT m.user_id, 'operator'::public.incident_recipient_relation FROM public.memberships m
         JOIN public.lots l ON l.establishment_id = m.establishment_id WHERE l.id = $3
       UNION ALL SELECT r.user_id, r.relation FROM public.incident_recipients r WHERE r.incident_id = $1
     ) link GROUP BY link.user_id`, [incidentId, version, lotId, at])
}

export function createIncidentRepository(pool: Pool): IncidentRepository {
  return {
    async findLot(lotId) {
      if (!uuid.test(lotId)) return null
      const { rows } = await pool.query<{ establishmentId: string }>(
        'SELECT establishment_id::text AS "establishmentId" FROM public.lots WHERE public_id = $1', [lotId])
      return rows[0] ?? null
    },

    async findIncident(incidentId) {
      if (!uuid.test(incidentId)) return null
      const { rows } = await pool.query<{ establishmentId: string }>(
        `SELECT l.establishment_id::text AS "establishmentId" FROM public.incidents i
         JOIN public.lots l ON l.id = i.lot_id WHERE i.public_id = $1`, [incidentId])
      return rows[0] ?? null
    },

    isMember: (userId, establishmentId) => member(pool, userId, establishmentId),

    async listByLot(lotId) {
      // Una sola consulta: cada incidencia y sus versiones pertenecen a la misma foto.
      const { rows } = await pool.query<IncidentView>(
        `SELECT ${incidentColumns} FROM public.incidents i JOIN public.lots l ON l.id = i.lot_id
         WHERE l.public_id = $1 ORDER BY i.id DESC LIMIT 50`, [lotId])
      return rows
    },

    async findEstablishment(establishmentId) {
      if (!uuid.test(establishmentId)) return null
      const { rows } = await pool.query<{ id: string }>(
        'SELECT id::text FROM public.establishments WHERE public_id = $1', [establishmentId])
      return rows[0]?.id ?? null
    },

    async listByEstablishment(establishmentId, { status, page }) {
      const { rows } = await pool.query<EstablishmentIncidentView>(
        `SELECT ${incidentColumns}, json_build_object('id', l.public_id::text, 'description', l.description) AS lot
         FROM public.incidents i JOIN public.lots l ON l.id = i.lot_id
         WHERE l.establishment_id = $1 AND ($2::public.incident_status IS NULL OR i.status = $2)
         ORDER BY i.id DESC LIMIT $3 OFFSET $4`, [establishmentId, status ?? null, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE])
      return { items: rows.slice(0, PAGE_SIZE), hasNextPage: rows.length > PAGE_SIZE }
    },

    async withReport(userId, lotId, key, operate) {
      return withTransaction(pool, async (client) => {
        await lockIntent(client, 'incident_report', userId, key)
        return operate({
          async prior() {
            const { rows } = await client.query<IncidentReport>(
              `SELECT i.public_id::text AS id, l.public_id::text AS "lotId", i.report_reason AS reason,
                 ${iso('i.created_at')} AS "createdAt"
               FROM public.incidents i JOIN public.lots l ON l.id = i.lot_id
               WHERE i.reported_by = $1 AND i.idempotency_key = $2`, [userId, key])
            return rows[0] ?? null
          },
          async hasAccess() {
            if (!uuid.test(lotId)) return false
            const { rowCount } = await client.query(
              `SELECT 1 FROM public.lots l WHERE l.public_id = $1 AND (
                 EXISTS (SELECT 1 FROM public.commitments c WHERE c.lot_id = l.id AND c.user_id = $2)
                 OR EXISTS (SELECT 1 FROM public.waitlist_entries w WHERE w.lot_id = l.id AND w.user_id = $2)
                 OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.establishment_id = l.establishment_id AND m.user_id = $2))`,
              [lotId, userId])
            return rowCount === 1
          },
          async insert(reason) {
            const { rows } = await client.query<IncidentReport>(
              `INSERT INTO public.incidents (lot_id, reported_by, report_reason, idempotency_key, created_at)
               SELECT l.id, $2, $3, $4, clock_timestamp() FROM public.lots l WHERE l.public_id = $1
               RETURNING public_id::text AS id, $1::text AS "lotId", report_reason AS reason, ${iso('created_at')} AS "createdAt"`,
              [lotId, userId, reason, key])
            return rows[0]!
          },
        })
      })
    },

    async withCommand(userId, incidentId, key, operate) {
      return withTransaction(pool, async (client) => {
        await lockIntent(client, 'incident_version', userId, key)
        const unavailable = async (): Promise<never> => { throw new Error('No se escribe sin incidencia') }
        const missing = { isMember: unavailable, prior: unavailable, publish: unavailable, closeLot: unavailable }
        if (!uuid.test(incidentId)) return operate(null, missing)
        const owner = await client.query<{ lot_id: string }>(
          `SELECT l.public_id::text AS lot_id FROM public.incidents i JOIN public.lots l ON l.id = i.lot_id
           WHERE i.public_id = $1`, [incidentId])
        const locked = owner.rows[0] && await lockLot(client, owner.rows[0].lot_id)
        if (!locked) return operate(null, missing)
        // Todas las versiones pasan por este bloqueo: el estado leído aquí sigue vigente al escribir.
        const { rows: [incident] } = await client.query<{ id: string; status: IncidentStatus; version: number; establishment_id: string;
          lot_status: LotStatus; pickup_ends_at: Date; reconciled: boolean }>(
          `SELECT i.id::text, i.status, i.version, l.establishment_id::text,
             l.status AS lot_status, l.pickup_ends_at, ${lotReconciledSql} AS reconciled FROM public.incidents i
           JOIN public.lots l ON l.id = i.lot_id WHERE i.public_id = $1`, [incidentId])
        return operate({ status: incident!.status, version: incident!.version, at: locked.at,
          lot: { id: owner.rows[0]!.lot_id, status: incident!.lot_status, pickupEndsAt: incident!.pickup_ends_at, reconciled: incident!.reconciled } }, {
          isMember: actorId => member(client, actorId, incident!.establishment_id),
          async closeLot(status, at) {
            await closeLot(client, locked.lotId, status, at, false)
            await client.query('UPDATE public.lots SET version=version+1, updated_at=$2 WHERE id=$1', [locked.lotId, locked.at])
          },
          async prior(actorId, intent) {
            const { rows } = await client.query<IncidentVersionResult>(
              `SELECT ${versionColumns} FROM public.incident_versions v JOIN public.incidents i ON i.id = v.incident_id
               WHERE v.published_by = $1 AND v.idempotency_key = $2`, [actorId, intent])
            return rows[0] ?? null
          },
          async publish(actorId, command, status: PublishedIncidentStatus) {
            const version = incident!.version + 1
            await client.query('UPDATE public.incidents SET status = $2, version = $3 WHERE id = $1', [incident!.id, status, version])
            await client.query(
              `INSERT INTO public.incident_versions (incident_id, version, status, reason, instructions, published_by, idempotency_key,
                 created_at, close_lot, lot_closed)
               SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9, l.status IN ('expired','withdrawn') OR l.pickup_ends_at <= $8
               FROM public.lots l WHERE l.id=$10`,
              [incident!.id, version, status, command.reason, command.instructions, actorId, command.idempotencyKey,
                locked.at, command.closeLot ?? false, locked.lotId])
            await fixRecipients(client, incident!.id, version, locked.lotId, locked.at)
            const { rows } = await client.query<IncidentVersionResult>(
              `SELECT ${versionColumns} FROM public.incident_versions v JOIN public.incidents i ON i.id = v.incident_id
               WHERE v.incident_id = $1 AND v.version = $2`, [incident!.id, version])
            return rows[0]!
          },
        })
      })
    },
  }
}

/** Los bloqueos de destinatarios duran solo la creación de una tanda; no se bloquea el lote. */
export function createIncidentDispatchRepository(pool: Pool): IncidentDispatchRepository {
  return {
    enqueue: limit => withTransaction(pool, async client => {
      const { rows } = await client.query<{ incident_id: string; version: number; user_id: string; relation: IncidentNotice['relation'];
        id: string; status: IncidentNotice['status']; reason: string; instructions: string; lot_closed: boolean;
        lot_id: string; description: string; created_at: Date }>(
        `SELECT r.incident_id::text, r.version, r.user_id::text, r.relation, i.public_id::text AS id,
           v.status, v.reason, v.instructions, v.lot_closed, l.public_id::text AS lot_id, l.description,
           GREATEST(v.created_at, r.created_at) AS created_at
         FROM public.incident_recipients r JOIN public.incident_versions v
           ON v.incident_id=r.incident_id AND v.version=r.version
         JOIN public.incidents i ON i.id=r.incident_id JOIN public.lots l ON l.id=i.lot_id
         WHERE r.outbox_event_id IS NULL ORDER BY r.incident_id,r.version,r.user_id
         LIMIT $1 FOR UPDATE OF r SKIP LOCKED`, [limit])
      for (const row of rows) {
        const eventId = await appendEvent(client, row.incident_id, { kind: 'incident_version', recipientUserId: row.user_id,
          payload: { lot: { id: row.lot_id, description: row.description }, quantity: 0,
            waitlistEntryId: null, reservationId: null, offerExpiresAt: null,
            incident: { id: row.id, version: row.version, status: row.status, reason: row.reason,
              instructions: row.instructions, relation: row.relation, lotClosed: row.lot_closed } },
        }, row.created_at, row.version)
        await client.query(`UPDATE public.incident_recipients SET outbox_event_id=$4
          WHERE incident_id=$1 AND version=$2 AND user_id=$3`, [row.incident_id, row.version, row.user_id, eventId])
      }
      return rows.length
    }),
  }
}
