// K028 · Infrastructure: reclamo con concesión y registro de los vencimientos de un lote.
// Todo ocurre bajo el bloqueo común del lote (ADR 0006) y con el mismo cliente: cola,
// reservas, contadores, estado del lote y concesión. Las condiciones de estado de cada
// UPDATE impiden liberar dos veces aunque dos trabajadores procesen el mismo lote.
import type { LotExpiryRepository } from '../../application/expiries/ports.js'
import type { LotStatus } from '../../domain/lots.js'
import { lockLot } from './lot-lock.js'
import { withTransaction } from './pool.js'
import type { Pool } from './pool.js'
import { settleQueue } from './waitlist-queue.js'

export function createLotExpiryRepository(pool: Pool): LotExpiryRepository {
  return {
    async claimNext(leaseMs, maxAttempts) {
      return withTransaction(pool, async (client) => {
        // Pendiente: cierre de un lote publicado u oferta cuya hora pasó, la más antigua
        // primero. SKIP LOCKED salta lotes que otro trabajador o un comando tienen bloqueados.
        const picked = await client.query<{ id: string }>(
          `WITH due AS (
             SELECT id AS lot_id, pickup_ends_at AS due_at FROM public.lots
             WHERE status = 'published' AND pickup_ends_at <= clock_timestamp()
             UNION ALL
             SELECT lot_id, offer_expires_at FROM public.waitlist_entries
             WHERE status = 'offered' AND offer_expires_at <= clock_timestamp())
           SELECT l.id FROM public.lots l
           JOIN (SELECT lot_id, min(due_at) AS due_at FROM due GROUP BY lot_id) d ON d.lot_id = l.id
           WHERE l.expiry_attempts < $1
             AND (l.expiry_claimed_until IS NULL OR l.expiry_claimed_until <= clock_timestamp())
           ORDER BY d.due_at, l.id LIMIT 1 FOR UPDATE OF l SKIP LOCKED`, [maxAttempts])
        if (!picked.rows[0]) return null
        // La foto de la consulta anterior puede ser previa al registro de otro trabajador
        // que soltó el lote justo antes del bloqueo. Con el lote bloqueado, una sentencia
        // nueva ve lo último confirmado: si ya no está pendiente, la siguiente vuelta sigue.
        const { rows } = await client.query<{ id: string; attempts: number }>(
          `UPDATE public.lots l SET expiry_attempts = expiry_attempts + 1,
             expiry_claimed_until = clock_timestamp() + $2 * interval '1 millisecond'
           WHERE l.id = $1 AND (l.status = 'published' AND l.pickup_ends_at <= clock_timestamp()
             OR EXISTS (SELECT 1 FROM public.waitlist_entries w WHERE w.lot_id = l.id
               AND w.status = 'offered' AND w.offer_expires_at <= clock_timestamp()))
           RETURNING public_id::text AS id, expiry_attempts AS attempts`, [picked.rows[0].id, leaseMs])
        return rows[0] ? { lotId: rows[0].id, attempts: rows[0].attempts } : null
      })
    },

    async withExpiryTransaction(lotId, operate) {
      return withTransaction(pool, async (client) => {
        const locked = await lockLot(client, lotId)
        const unavailable = () => { throw new Error('Sin lote no se registran vencimientos') }
        if (!locked) return operate(null, { settleQueue: unavailable, expireReservations: unavailable,
          closeLot: unavailable, complete: unavailable })
        const { rows } = await client.query<{ status: LotStatus; pickup_ends_at: Date }>(
          'SELECT status::text, pickup_ends_at FROM public.lots WHERE id = $1', [locked.lotId])
        return operate({ status: rows[0]!.status, pickupEndsAt: rows[0]!.pickup_ends_at, now: locked.at }, {
          settleQueue: () => settleQueue(client, locked.lotId, locked.at),
          async expireReservations(at) {
            const expired = await client.query<{ quantity: number }>(
              `UPDATE public.commitments SET status = 'expired', ended_at = $2, pickup_code_ciphertext = NULL
               WHERE lot_id = $1 AND status = 'confirmed' RETURNING quantity`, [locked.lotId, at])
            const packs = expired.rows.reduce((total, row) => total + row.quantity, 0)
            // Tras el cierre el lote ya no es asignable: R → X (anexos B p. 4).
            if (packs > 0) await client.query(
              `UPDATE public.lots SET reserved_quantity = reserved_quantity - $2,
                 expired_quantity = expired_quantity + $2 WHERE id = $1`, [locked.lotId, packs])
            return expired.rows.length
          },
          async closeLot(at) {
            // F → X: free_quantity aquí es el valor previo; tras el UPDATE queda en 0.
            await client.query(
              `UPDATE public.lots SET status = 'expired', closed_at = $2,
                 expired_quantity = expired_quantity + free_quantity
               WHERE id = $1 AND status = 'published'`, [locked.lotId, at])
          },
          async complete() {
            await client.query(
              'UPDATE public.lots SET expiry_attempts = 0, expiry_claimed_until = NULL WHERE id = $1', [locked.lotId])
          },
        })
      })
    },

    async release(lotId, attempts, retryAfterMs) {
      await pool.query(
        `UPDATE public.lots SET expiry_claimed_until = CASE WHEN $3::bigint IS NULL THEN NULL
           ELSE clock_timestamp() + $3::bigint * interval '1 millisecond' END
         WHERE public_id = $1 AND expiry_attempts = $2`, [lotId, attempts, retryAfterMs])
    },
  }
}
