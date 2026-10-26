// K037 · Infrastructure · mensajes del chat de la reserva (ADR 0016). El envío serializa la
// clave del autor y después toma el bloqueo común del lote (ADR 0006), así que se ordena
// con cancelar, retirar y vencer, que también lo toman.
import type { ChatRepository, ChatReservation, Participation, SentMessage } from '../../application/chat/ports.js'
import { lockIntent, lockLot } from './lot-lock.js'
import { withTransaction } from './pool.js'
import type { Pool, PoolClient } from './pool.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ReservationRow {
  commitment_id: string; lot_id: string; participation: Participation
  ended_at: Date | null; pickup_ends_at: Date; closed_at: Date | null
}

/** El titular se reconoce primero. Un operador tiene que ser miembro del establecimiento del lote */
async function findReservationRow(db: Pool | PoolClient, userId: string, reservationId: string) {
  if (!uuid.test(reservationId)) return null
  const { rows } = await db.query<ReservationRow>(
    `SELECT c.id::text AS commitment_id, l.public_id::text AS lot_id, c.ended_at, l.pickup_ends_at, l.closed_at,
       CASE WHEN c.user_id = $1 THEN 'holder'
         WHEN EXISTS (SELECT 1 FROM public.memberships m
           WHERE m.user_id = $1 AND m.establishment_id = l.establishment_id) THEN 'operator' END AS participation
     FROM public.commitments c JOIN public.lots l ON l.id = c.lot_id
     WHERE c.public_id = $2`, [userId, reservationId])
  return rows[0] ?? null
}

const toReservation = (row: ReservationRow): ChatReservation => ({ participation: row.participation,
  endedAt: row.ended_at, pickupEndsAt: row.pickup_ends_at, lotClosedAt: row.closed_at })

const sentColumns = 'm.public_id::text AS id, m.sequence, m.created_at'
const toSent = (row: { id: string; sequence: number; created_at: Date }): SentMessage =>
  ({ id: row.id, sequence: row.sequence, createdAt: row.created_at })

export function createChatRepository(pool: Pool): ChatRepository {
  return {
    async findReservation(userId, reservationId) {
      const row = await findReservationRow(pool, userId, reservationId)
      return row ? toReservation(row) : null
    },

    async listMessages(userId, reservationId, after, limit) {
      const { rows } = await pool.query<{ id: string; sequence: number; created_at: Date
        author: 'holder' | 'operator'; mine: boolean; text: string }>(
        `SELECT ${sentColumns}, m.body AS text, m.author_user_id = $1 AS mine,
           CASE WHEN m.author_user_id = c.user_id THEN 'holder' ELSE 'operator' END AS author
         FROM public.chat_messages m JOIN public.commitments c ON c.id = m.commitment_id
         WHERE c.public_id = $2 AND m.sequence > $3 AND m.body IS NOT NULL
         ORDER BY m.sequence LIMIT $4`, [userId, reservationId, after, limit])
      return rows.map(row => ({ ...toSent(row), author: row.author, mine: row.mine, text: row.text }))
    },

    async withSendTransaction(userId, reservationId, key, text, operate) {
      return withTransaction(pool, async (client) => {
        const unavailable = { append: async () => { throw new Error('Sin reserva no se envía') } }
        await lockIntent(client, 'message', userId, key)
        const prior = await client.query<{ id: string; sequence: number; created_at: Date
          reservation_id: string; text_matches: boolean }>(
          `SELECT ${sentColumns}, c.public_id::text AS reservation_id,
             COALESCE(m.body = $3, true) AS text_matches
           FROM public.chat_messages m JOIN public.commitments c ON c.id = m.commitment_id
           WHERE m.author_user_id = $1 AND m.idempotency_key = $2`, [userId, key, text])
        const previous = prior.rows[0]
        if (previous) {
          return operate({ existing: { ...toSent(previous), reservationId: previous.reservation_id,
            textMatches: previous.text_matches } }, unavailable)
        }
        // Alguien ajeno a la reserva no alcanza a hacer esperar a los demás comandos del lote
        const found = await findReservationRow(client, userId, reservationId)
        const locked = found?.participation && await lockLot(client, found.lot_id)
        if (!locked) return operate({ existing: null, reservation: null }, unavailable)
        // Se relee después del bloqueo porque otra transacción pudo cancelarla o retirarla mientras esperaba
        const row = (await findReservationRow(client, userId, reservationId))!
        return operate({ existing: null, reservation: toReservation(row), now: locked.at }, {
          async append(body, at) {
            const { rows } = await client.query<{ id: string; sequence: number; created_at: Date }>(
              `INSERT INTO public.chat_messages AS m
                 (commitment_id, author_user_id, sequence, idempotency_key, body, created_at)
               SELECT $1, $2, COALESCE(max(sequence), 0) + 1, $3, $4, $5
               FROM public.chat_messages WHERE commitment_id = $1
               RETURNING ${sentColumns}`, [row.commitment_id, userId, key, body, at])
            return toSent(rows[0]!)
          },
        })
      })
    },

    async eraseExpired(retentionDays) {
      // LEAST ignora los NULL y calcula lo mismo que conversationClosesAt en Domain
      const { rowCount } = await pool.query(
        `UPDATE public.chat_messages m SET body = NULL
         FROM public.commitments c JOIN public.lots l ON l.id = c.lot_id
         WHERE c.id = m.commitment_id AND m.body IS NOT NULL
           AND LEAST(c.ended_at, l.pickup_ends_at, l.closed_at) <= clock_timestamp() - $1 * interval '1 day'`,
        [retentionDays])
      return rowCount ?? 0
    },
  }
}
