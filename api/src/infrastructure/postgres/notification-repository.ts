// K030 · Infrastructure: bandeja de avisos y outbox en PostgreSQL (ADR 0012). No decide
// permisos ni reintentos: ejecuta las consultas que Application pide.
import type {
  ClaimedEvent, NotificationRepository, OutboxRepository, StoredNotification,
} from '../../application/notifications/ports.js'
import type { NotificationKind, NotificationPayload } from '../../domain/notifications.js'
import { OUTBOX_MAX_ATTEMPTS } from '../../domain/notifications.js'
import { withTransaction } from './pool.js'
import type { Pool } from './pool.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface NotificationRow { id: string; kind: NotificationKind; payload: NotificationPayload; created_at: Date; read_at: Date | null }
const notificationColumns = 'n.public_id::text AS id, n.kind, n.payload, n.created_at, n.read_at'
const toNotification = (row: NotificationRow): StoredNotification =>
  ({ id: row.id, kind: row.kind, payload: row.payload, createdAt: row.created_at, readAt: row.read_at })

export function createNotificationRepository(pool: Pool): NotificationRepository {
  return {
    async listByUser(userId, page) {
      const [items, unread] = await Promise.all([
        pool.query<NotificationRow>(
          `SELECT ${notificationColumns} FROM public.notifications n WHERE n.user_id = $1
           ORDER BY n.created_at DESC, n.id DESC LIMIT 21 OFFSET $2`, [userId, (page - 1) * 20]),
        pool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM public.notifications WHERE user_id = $1 AND read_at IS NULL', [userId]),
      ])
      return { items: items.rows.slice(0, 20).map(toNotification), hasNextPage: items.rows.length > 20,
        unreadCount: unread.rows[0]!.count }
    },

    async markRead(userId, notificationId, at) {
      if (!uuid.test(notificationId)) return null
      const { rows } = await pool.query<NotificationRow>(
        `UPDATE public.notifications n SET read_at = COALESCE(n.read_at, GREATEST($3::timestamptz, n.created_at))
         WHERE n.user_id = $1 AND n.public_id = $2 RETURNING ${notificationColumns}`, [userId, notificationId, at])
      return rows[0] ? toNotification(rows[0]) : null
    },
  }
}

export function createOutboxRepository(pool: Pool): OutboxRepository {
  return {
    async claim(limit, at, claimedUntil) {
      // Un reclamo vencido tras agotar los intentos (worker caído en cada intento) queda visible.
      await pool.query(
        `UPDATE public.outbox_events SET status = 'failed', claimed_until = NULL, last_error = 'LEASE_EXPIRED'
         WHERE status = 'pending' AND attempts >= $2 AND claimed_until <= $1`, [at, OUTBOX_MAX_ATTEMPTS])
      // SKIP LOCKED: dos procesos no reclaman el mismo evento; el reclamo se confirma al responder.
      const { rows } = await pool.query<{ id: string; event_type: NotificationKind; recipient_user_id: string
        payload: NotificationPayload; created_at: Date; attempts: number }>(
        `WITH picked AS (
           SELECT id FROM public.outbox_events
           WHERE status = 'pending' AND available_at <= $1 AND (claimed_until IS NULL OR claimed_until <= $1)
           ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
         UPDATE public.outbox_events e SET claimed_until = $3, attempts = e.attempts + 1
         FROM picked WHERE e.id = picked.id
         RETURNING e.id::text, e.event_type, e.recipient_user_id::text, e.payload, e.created_at, e.attempts`,
        [at, limit, claimedUntil])
      return rows.map((row): ClaimedEvent => ({ id: row.id, kind: row.event_type, recipientUserId: row.recipient_user_id,
        payload: row.payload, createdAt: row.created_at, attempts: row.attempts }))
        .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)))
    },

    async deliver(event, at) {
      await withTransaction(pool, async (client) => {
        // El aviso conserva el instante de la transición; generarlo es un estado aparte de leerlo.
        await client.query(
          `INSERT INTO public.notifications (event_id, user_id, kind, payload, created_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT ON CONSTRAINT notifications_event_user_key DO NOTHING`,
          [event.id, event.recipientUserId, event.kind, JSON.stringify(event.payload), event.createdAt])
        await client.query(
          `UPDATE public.outbox_events SET status = 'processed', processed_at = $2, claimed_until = NULL, last_error = NULL
           WHERE id = $1 AND status = 'pending'`, [event.id, at])
      })
    },

    async release(eventId, retryAt, errorCode) {
      if (retryAt) {
        await pool.query(
          `UPDATE public.outbox_events SET available_at = $2, claimed_until = NULL, last_error = $3
           WHERE id = $1 AND status = 'pending'`, [eventId, retryAt, errorCode])
      } else {
        await pool.query(
          `UPDATE public.outbox_events SET status = 'failed', claimed_until = NULL, last_error = $2
           WHERE id = $1 AND status = 'pending'`, [eventId, errorCode])
      }
    },
  }
}
