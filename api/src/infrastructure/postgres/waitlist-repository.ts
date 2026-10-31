// K027 · Infrastructure: cola FIFO y ofertas bajo el bloqueo común del lote (ADR 0006).
// Cada comando cambia la solicitud, el contador y la reserva con el mismo cliente; las
// condiciones `status = …` de los UPDATE impiden una segunda transición.
import type {
  EntryState, JoinState, StoredWaitlistEntry, WaitlistRepository,
} from '../../application/waitlist/ports.js'
import type { WaitlistStatus } from '../../domain/waitlist.js'
import { isAssignable } from '../../domain/waitlist.js'
import { lockIntent, lockLot } from './lot-lock.js'
import { appendEvent } from './outbox.js'
import { withTransaction } from './pool.js'
import type { Pool, PoolClient } from './pool.js'
import { lotReconciledSql, settleQueue } from './waitlist-queue.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const bytes = (value: Uint8Array) => Buffer.from(value)

interface EntryRow {
  id: string; requested_quantity: number; status: WaitlistStatus; offered_quantity: number | null
  offer_expires_at: Date | null; position: number | null; reservation_id: string | null
  created_at: Date; ended_at: Date | null; lot_id: string; description: string; conditions: string | null
  address: string; latitude: number; longitude: number; time_zone: string
  pickup_starts_at: Date; pickup_ends_at: Date
}
interface HeldRow extends EntryRow {
  internal_id: string; user_id: string; lot_internal_id: string; lot_status: string
}
// La posición cuenta a quienes esperan por delante y a la propia solicitud; solo existe mientras espera.
const entryColumns = `e.public_id::text AS id, e.requested_quantity, e.status, e.offered_quantity,
  e.offer_expires_at, e.created_at, e.ended_at, c.public_id::text AS reservation_id,
  CASE WHEN e.status = 'waiting' THEN (SELECT count(*)::int FROM public.waitlist_entries w
    WHERE w.lot_id = e.lot_id AND w.status = 'waiting' AND w.id <= e.id) END AS position,
  l.public_id::text AS lot_id, l.description, l.conditions, l.address, l.latitude, l.longitude,
  l.time_zone, l.pickup_starts_at, l.pickup_ends_at`
const entryFrom = `FROM public.waitlist_entries e JOIN public.lots l ON l.id = e.lot_id
  LEFT JOIN public.commitments c ON c.id = e.commitment_id`
const heldColumns = `${entryColumns}, e.id::text AS internal_id, e.user_id::text AS user_id,
  l.id::text AS lot_internal_id, l.status::text AS lot_status`

function toEntry(row: EntryRow): StoredWaitlistEntry {
  return { id: row.id, requestedQuantity: row.requested_quantity, status: row.status,
    offeredQuantity: row.offered_quantity, offerExpiresAt: row.offer_expires_at, position: row.position,
    reservationId: row.reservation_id, createdAt: row.created_at, endedAt: row.ended_at,
    lot: { id: row.lot_id, description: row.description, conditions: row.conditions, address: row.address,
      latitude: row.latitude, longitude: row.longitude, timeZone: row.time_zone,
      pickupStartsAt: row.pickup_starts_at, pickupEndsAt: row.pickup_ends_at } }
}

async function findHeld(db: Pool | PoolClient, userId: string, entryId: string) {
  if (!uuid.test(entryId)) return null
  const { rows } = await db.query<HeldRow>(
    `SELECT ${heldColumns} ${entryFrom} WHERE e.user_id = $1 AND e.public_id = $2`, [userId, entryId])
  return rows[0] ?? null
}

export function createWaitlistRepository(pool: Pool): WaitlistRepository {
  return {
    async listByHolder(userId, page) {
      const { rows } = await pool.query<EntryRow>(
        `SELECT ${entryColumns} ${entryFrom} WHERE e.user_id = $1
         ORDER BY e.created_at DESC, e.id DESC LIMIT 21 OFFSET $2`, [userId, (page - 1) * 20])
      return { items: rows.slice(0, 20).map(toEntry), hasNextPage: rows.length > 20 }
    },

    async findByHolder(userId, entryId) {
      const row = await findHeld(pool, userId, entryId)
      return row ? toEntry(row) : null
    },

    async withJoinTransaction(userId, lotId, key, operate) {
      return withTransaction(pool, async (client) => {
        const unavailable = { enqueue: async () => { throw new Error('No se entra a la espera sin lote publicado') } }
        // Una clave reintentada sobre otro lote también se serializa por usuario.
        await lockIntent(client, 'waitlist', userId, key)
        const prior = await client.query<EntryRow>(
          `SELECT ${entryColumns} ${entryFrom} WHERE e.user_id = $1 AND e.idempotency_key = $2`, [userId, key])
        if (prior.rows[0]) return operate({ existing: { ...toEntry(prior.rows[0]), lotId: prior.rows[0].lot_id } }, unavailable)
        const locked = await lockLot(client, lotId)
        // Vencido ya registrado (K028) responde igual que cerrado sin registrar.
        const published = locked && await client.query(
          "SELECT 1 FROM public.lots WHERE id = $1 AND paused_at IS NULL AND status IN ('published', 'expired')", [locked.lotId])
        if (!locked || published?.rowCount !== 1) return operate({ existing: null, lot: null }, unavailable)
        // Una oferta vencida aún retiene packs: se registra antes de medir lo libre.
        await settleQueue(client, locked.lotId, locked.at)
        const found = await client.query<{ quantity: number; available_quantity: number; pickup_ends_at: Date
          queued: boolean; active: boolean; reconciled: boolean }>(
          `SELECT l.quantity, l.free_quantity AS available_quantity, l.pickup_ends_at,
             EXISTS (SELECT 1 FROM public.waitlist_entries w WHERE w.lot_id = l.id AND w.status = 'waiting') AS queued,
             (EXISTS (SELECT 1 FROM public.commitments c WHERE c.user_id = $1 AND c.lot_id = l.id AND c.status = 'confirmed')
              OR EXISTS (SELECT 1 FROM public.waitlist_entries w WHERE w.user_id = $1 AND w.lot_id = l.id
                AND w.status IN ('waiting', 'offered'))) AS active,
             ${lotReconciledSql} AS reconciled
           FROM public.lots l WHERE l.id = $2`, [userId, locked.lotId])
        const row = found.rows[0]!
        const state: JoinState = { existing: null, now: locked.at, active: row.active, queued: row.queued,
          reconciled: row.reconciled,
          lot: { quantity: row.quantity, availableQuantity: row.available_quantity, pickupEndsAt: row.pickup_ends_at } }
        return operate(state, {
          async enqueue(quantity, at) {
            const inserted = await client.query<{ id: string }>(
              `INSERT INTO public.waitlist_entries (user_id, lot_id, requested_quantity, idempotency_key, created_at)
               VALUES ($1, $2, $3, $4, $5) RETURNING id::text`, [userId, locked.lotId, quantity, key, at])
            // ADR 0002: si hay libres, la cabeza recibe de inmediato una oferta, parcial si no alcanza.
            await settleQueue(client, locked.lotId, at)
            const reread = await client.query<EntryRow>(
              `SELECT ${entryColumns} ${entryFrom} WHERE e.id = $1`, [inserted.rows[0]!.id])
            return toEntry(reread.rows[0]!)
          },
        })
      })
    },

    async withEntryTransaction(userId, entryId, operate) {
      return withTransaction(pool, async (client) => {
        const unavailable = {
          accept: async () => { throw new Error('Sin solicitud no se acepta') },
          decline: async () => { throw new Error('Sin solicitud no se rechaza') },
          leave: async () => { throw new Error('Sin solicitud no se sale') },
        }
        const owned = await findHeld(client, userId, entryId)
        const locked = owned && await lockLot(client, owned.lot_id)
        if (!owned || !locked) return operate(null, unavailable)
        // Relectura tras esperar el bloqueo y registrar los vencimientos pendientes del lote.
        await settleQueue(client, locked.lotId, locked.at)
        const row = (await findHeld(client, userId, entryId))!
        const state: EntryState = { entry: toEntry(row), now: locked.at }
        return operate(state, {
          async accept(code, at) {
            const quantity = row.offered_quantity!
            const reservation = await client.query<{ id: string; public_id: string }>(
              `INSERT INTO public.commitments (user_id, lot_id, quantity, status, created_at,
                 pickup_code_ciphertext, pickup_code_fingerprint)
               VALUES ($1, $2, $3, 'confirmed', $4, $5, $6) RETURNING id::text, public_id::text AS public_id`,
              [userId, locked.lotId, quantity, at, bytes(code.ciphertext), bytes(code.fingerprint)])
            const updated = await client.query(
              `UPDATE public.waitlist_entries SET status = 'accepted', ended_at = $2, commitment_id = $3
               WHERE id = $1 AND status = 'offered'`, [row.internal_id, at, reservation.rows[0]!.id])
            if (updated.rowCount !== 1) throw new Error('La aceptación no afectó ninguna solicitud')
            // O → R, sin descontar F otra vez (ADR 0002).
            await client.query(
              `UPDATE public.lots SET offered_quantity = offered_quantity - $2,
                 reserved_quantity = reserved_quantity + $2 WHERE id = $1`, [locked.lotId, quantity])
            // K030: el aviso de la reserva confirmada nace con la aceptación (ADR 0012); sin código.
            await appendEvent(client, reservation.rows[0]!.id, { kind: 'reservation_confirmed', recipientUserId: row.user_id,
              payload: { lot: { id: row.lot_id, description: row.description }, quantity, waitlistEntryId: row.id,
                reservationId: reservation.rows[0]!.public_id, offerExpiresAt: null } }, at)
            return reservation.rows[0]!.public_id
          },
          async decline(at) {
            const quantity = row.offered_quantity!
            const updated = await client.query(
              `UPDATE public.waitlist_entries SET status = 'declined', ended_at = $2
               WHERE id = $1 AND status = 'offered'`, [row.internal_id, at])
            if (updated.rowCount !== 1) throw new Error('El rechazo no afectó ninguna solicitud')
            // O → F si el lote sigue asignando, O → X si no; lo liberado se ofrece a quien sigue.
            const assignable = isAssignable({ status: row.lot_status, pickupEndsAt: row.pickup_ends_at }, at)
            await client.query(
              `UPDATE public.lots SET offered_quantity = offered_quantity - $2,
                 expired_quantity = expired_quantity + $3 WHERE id = $1`,
              [locked.lotId, quantity, assignable ? 0 : quantity])
            await settleQueue(client, locked.lotId, at)
          },
          async leave(at) {
            const updated = await client.query(
              `UPDATE public.waitlist_entries SET status = 'left', ended_at = $2
               WHERE id = $1 AND status = 'waiting'`, [row.internal_id, at])
            if (updated.rowCount !== 1) throw new Error('La salida no afectó ninguna solicitud')
          },
        })
      })
    }
  }
}
