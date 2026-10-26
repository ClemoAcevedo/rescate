// K022 · Infrastructure: cancelación y retiro bajo el bloqueo común del
// lote (ADR 0006). Cada transición cambia el estado, el código y el contador con el
// mismo cliente; la condición status = 'confirmed' impide una segunda transición.
import type {
  HolderReservation, PickupReviewState, PickupState, PickupWriter, ReservationRepository, ReviewedReservation,
  StoredReservation,
} from '../../application/reservations/ports.js'
import type { ReservationStatus } from '../../domain/reservations.js'
import { lockIntent, lockLot } from './lot-lock.js'
import { withTransaction } from './pool.js'
import type { Pool, PoolClient } from './pool.js'
import { appendEvent } from './outbox.js'
import { settleQueue } from './waitlist-queue.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const bytes = (value: Uint8Array | null) => value === null ? null : Buffer.from(value)

interface HeldRow {
  id: string; quantity: number; status: ReservationStatus; created_at: Date; ended_at: Date | null
  code_ciphertext?: Buffer | null; lot_id: string; description: string; conditions: string | null
  address: string; latitude: number; longitude: number; time_zone: string
  pickup_starts_at: Date; pickup_ends_at: Date
}
const heldColumns = `c.public_id::text AS id, c.quantity, c.status, c.created_at, c.ended_at,
  l.public_id::text AS lot_id, l.description, l.conditions, l.address, l.latitude, l.longitude,
  l.time_zone, l.pickup_starts_at, l.pickup_ends_at`

function toStored(row: HeldRow): StoredReservation {
  return { id: row.id, quantity: row.quantity, status: row.status, createdAt: row.created_at, endedAt: row.ended_at,
    lot: { id: row.lot_id, description: row.description, conditions: row.conditions, address: row.address,
      latitude: row.latitude, longitude: row.longitude, timeZone: row.time_zone,
      pickupStartsAt: row.pickup_starts_at, pickupEndsAt: row.pickup_ends_at } }
}
function toHolder(row: HeldRow): HolderReservation {
  return { ...toStored(row), codeCiphertext: row.code_ciphertext ? new Uint8Array(row.code_ciphertext) : null }
}

async function findHeld(db: Pool | PoolClient, userId: string, reservationId: string) {
  if (!uuid.test(reservationId)) return null
  const { rows } = await db.query<HeldRow & { internal_id: string; lot_internal_id: string }>(
    `SELECT ${heldColumns}, c.pickup_code_ciphertext AS code_ciphertext,
       c.id::text AS internal_id, l.id::text AS lot_internal_id
     FROM public.commitments c JOIN public.lots l ON l.id = c.lot_id
     WHERE c.user_id = $1 AND c.public_id = $2`, [userId, reservationId])
  return rows[0] ?? null
}

/** Pasa una reserva confirmada a un estado terminal y borra su código legible. */
async function endReservation(client: PoolClient, commitmentId: string, status: ReservationStatus, at: Date): Promise<number> {
  const { rows } = await client.query<{ quantity: number }>(
    `UPDATE public.commitments SET status = $2, ended_at = $3, pickup_code_ciphertext = NULL
     WHERE id = $1 AND status = 'confirmed' RETURNING quantity`, [commitmentId, status, at])
  // La reserva se releyó confirmada bajo el bloqueo: no puede haber cambiado.
  if (!rows[0]) throw new Error('La transición de la reserva no afectó ninguna fila')
  return rows[0].quantity
}

const membership = `EXISTS (SELECT 1 FROM public.memberships m
  WHERE m.user_id = $1 AND m.establishment_id = l.establishment_id)`

/** Revisión sin bloquear el lote: permiso sobre el lote y la reserva del lote con esa huella. */
async function findPickup(client: PoolClient, userId: string, lotId: string,
  fingerprint: Uint8Array | null): Promise<PickupReviewState | null> {
  if (!uuid.test(lotId)) return null
  const { rows } = await client.query<{ member: boolean; pickup_starts_at: Date; pickup_ends_at: Date
    id: string | null; quantity: number; status: ReservationStatus; created_at: Date; ended_at: Date | null }>(
    `SELECT ${membership} AS member, l.pickup_starts_at, l.pickup_ends_at,
       c.public_id::text AS id, c.quantity, c.status, c.created_at, c.ended_at
     FROM public.lots l
     LEFT JOIN public.commitments c ON c.lot_id = l.id AND c.pickup_code_fingerprint = $3
     WHERE l.public_id = $2`, [userId, lotId, bytes(fingerprint)])
  const row = rows[0]
  if (!row) return null
  const reservation: ReviewedReservation | null = row.id === null ? null : { id: row.id, quantity: row.quantity,
    status: row.status, createdAt: row.created_at, endedAt: row.ended_at }
  return { member: row.member, lot: { pickupStartsAt: row.pickup_starts_at, pickupEndsAt: row.pickup_ends_at }, reservation }
}

/** Serializa la clave del operador, bloquea el lote y relee reserva, permiso y reloj con el mismo cliente. */
async function withPickup<T>(client: PoolClient, operatorUserId: string, lotId: string, reservationId: string,
  fingerprint: Uint8Array | null, key: string,
  operate: (state: PickupState, writer: PickupWriter) => Promise<T>): Promise<T> {
  const unavailable = { deliver: async () => { throw new Error('No se entrega sin reserva válida') } }
  // Dos operadores pueden competir por la misma reserva; la clave solo serializa al mismo operador.
  await lockIntent(client, 'pickup', operatorUserId, key)
  const prior = await client.query<{ reservation_id: string; lot_id: string; quantity: number
    delivered_at: Date; code_matches: boolean; member: boolean }>(
    `SELECT c.public_id::text AS reservation_id, l.public_id::text AS lot_id, d.quantity, d.delivered_at,
       COALESCE(c.pickup_code_fingerprint = $3, false) AS code_matches, ${membership} AS member
     FROM public.deliveries d
     JOIN public.commitments c ON c.id = d.commitment_id JOIN public.lots l ON l.id = c.lot_id
     WHERE d.operator_user_id = $1 AND d.idempotency_key = $2`, [operatorUserId, key, bytes(fingerprint)])
  const previous = prior.rows[0]
  if (previous) {
    return operate({ member: previous.member, existing: { reservationId: previous.reservation_id,
      lotId: previous.lot_id, quantity: previous.quantity, deliveredAt: previous.delivered_at,
      codeMatches: previous.code_matches } } satisfies PickupState, unavailable)
  }
  const locked = await lockLot(client, lotId)
  if (!locked) return operate({ existing: null, lot: null }, unavailable)
  const { rows } = await client.query<{ member: boolean; pickup_starts_at: Date; pickup_ends_at: Date
    commitment_id: string | null; status: ReservationStatus; quantity: number }>(
    `SELECT ${membership} AS member, l.pickup_starts_at, l.pickup_ends_at,
       c.id::text AS commitment_id, c.status, c.quantity
     FROM public.lots l
     LEFT JOIN public.commitments c ON c.lot_id = l.id AND c.public_id = $3 AND c.pickup_code_fingerprint = $4
     WHERE l.id = $2`,
    [operatorUserId, locked.lotId, uuid.test(reservationId) ? reservationId : null, bytes(fingerprint)])
  const row = rows[0]!
  return operate({ existing: null, member: row.member, now: locked.at,
    lot: { pickupStartsAt: row.pickup_starts_at, pickupEndsAt: row.pickup_ends_at },
    reservation: row.commitment_id === null ? null : { status: row.status, quantity: row.quantity } }, {
    async deliver(at) {
      const quantity = await endReservation(client, row.commitment_id!, 'delivered', at)
      // R → E y la entrega que lo respalda, juntos (ADR 0006).
      await client.query(
        `UPDATE public.lots SET reserved_quantity = reserved_quantity - $2,
           delivered_quantity = delivered_quantity + $2 WHERE id = $1`, [locked.lotId, quantity])
      await client.query(
        `INSERT INTO public.deliveries (commitment_id, operator_user_id, quantity, delivered_at, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)`, [row.commitment_id, operatorUserId, quantity, at, key])
      return { reservationId, quantity, deliveredAt: at }
    },
  })
}

export function createReservationRepository(pool: Pool): ReservationRepository {
  return {
    async listByHolder(userId, page) {
      const { rows } = await pool.query<HeldRow>(
        `SELECT ${heldColumns} FROM public.commitments c JOIN public.lots l ON l.id = c.lot_id
         WHERE c.user_id = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 21 OFFSET $2`,
        [userId, (page - 1) * 20])
      return { items: rows.slice(0, 20).map(toStored), hasNextPage: rows.length > 20 }
    },

    async findByHolder(userId, reservationId) {
      const row = await findHeld(pool, userId, reservationId)
      return row ? toHolder(row) : null
    },

    async withHolderTransaction(userId, reservationId, operate) {
      return withTransaction(pool, async (client) => {
        const unavailable = {
          cancel: async () => { throw new Error('Sin reserva no se cancela') },
          assignCode: async () => { throw new Error('Sin reserva no se emite código') },
        }
        const owned = await findHeld(client, userId, reservationId)
        const locked = owned && await lockLot(client, owned.lot_id)
        if (!locked) return operate(null, unavailable)
        // Relectura después de esperar el bloqueo: otra transacción pudo terminarla.
        const row = (await findHeld(client, userId, reservationId))!
        return operate({ reservation: toHolder(row), now: locked.at }, {
          async cancel(at) {
            const quantity = await endReservation(client, row.internal_id, 'cancelled', at)
            // R → F en la misma transacción (ADR 0006).
            await client.query('UPDATE public.lots SET reserved_quantity = reserved_quantity - $2 WHERE id = $1',
              [row.lot_internal_id, quantity])
            // K030: el aviso de la cancelación nace con ella (ADR 0012).
            await appendEvent(client, row.internal_id, { kind: 'reservation_cancelled', recipientUserId: userId,
              payload: { lot: { id: row.lot_id, description: row.description }, quantity, waitlistEntryId: null,
                reservationId: row.id, offerExpiresAt: null } }, at)
            // Lo liberado se ofrece a quien sigue en la cola (RF07) bajo el mismo bloqueo.
            await settleQueue(client, row.lot_internal_id, at)
          },
          async assignCode(code) {
            const updated = await client.query(
              `UPDATE public.commitments SET pickup_code_ciphertext = $2, pickup_code_fingerprint = $3
               WHERE id = $1 AND status = 'confirmed' AND pickup_code_fingerprint IS NULL`,
              [row.internal_id, bytes(code.ciphertext), bytes(code.fingerprint)])
            if (updated.rowCount !== 1) throw new Error('El código no se asoció a la reserva')
          },
        })
      })
    },

    async withPickupAttempts(operatorUserId, operate) {
      return withTransaction(pool, async (client) => {
        // K034: primer bloqueo de todo intento de código, antes de la clave y del lote, con
        // el límite de espera de anexos H p. 20. ON CONFLICT espera una inicialización concurrente.
        await client.query("SET LOCAL lock_timeout = '2s'")
        await client.query(`INSERT INTO public.pickup_code_security_state (user_id) VALUES ($1)
          ON CONFLICT (user_id) DO NOTHING`, [operatorUserId])
        await client.query('SELECT user_id FROM public.pickup_code_security_state WHERE user_id = $1 FOR UPDATE',
          [operatorUserId])
        // Relectura en otra sentencia: su snapshot ya incluye lo confirmado por quien tenía el bloqueo.
        const { rows } = await client.query<{ blocked_until: Date | null; failure_times: Date[]; now: Date }>(
          `SELECT s.blocked_until, clock_timestamp() AS now, ARRAY(SELECT f.failed_at FROM public.pickup_code_failures f
             WHERE f.user_id = s.user_id ORDER BY f.failed_at, f.id) AS failure_times
           FROM public.pickup_code_security_state s WHERE s.user_id = $1`, [operatorUserId])
        const state = rows[0]
        if (!state) throw new Error('No se pudo releer el estado de intentos bloqueado')
        return operate({ blockedUntil: state.blocked_until, failureTimes: state.failure_times, now: state.now }, {
          review: (lotId, fingerprint) => findPickup(client, operatorUserId, lotId, fingerprint),
          confirm: (lotId, reservationId, fingerprint, key, confirm) =>
            withPickup(client, operatorUserId, lotId, reservationId, fingerprint, key, confirm),
          async deleteFailuresThrough(cutoff) {
            await client.query('DELETE FROM public.pickup_code_failures WHERE user_id = $1 AND failed_at <= $2',
              [operatorUserId, cutoff])
          },
          async recordFailure(at) {
            await client.query('INSERT INTO public.pickup_code_failures (user_id, failed_at) VALUES ($1, $2)',
              [operatorUserId, at])
          },
          async setBlockedUntil(until) {
            await client.query('UPDATE public.pickup_code_security_state SET blocked_until = $2 WHERE user_id = $1',
              [operatorUserId, until])
          },
        })
      })
    },
  }
}
