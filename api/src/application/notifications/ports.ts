// K030 · Application: límites hacia Infrastructure para avisos y outbox. No exponen pg ni SQL.
import type { NotificationKind, NotificationPayload } from '../../domain/notifications.js'

/** Aviso de su destinatario; `id` es el identificador público. */
export interface StoredNotification {
  id: string
  kind: NotificationKind
  payload: NotificationPayload
  createdAt: Date
  readAt: Date | null
}

/** Evento reclamado del outbox; `attempts` ya incluye el intento en curso. */
export interface ClaimedEvent {
  id: string
  kind: NotificationKind
  recipientUserId: string
  payload: NotificationPayload
  createdAt: Date
  attempts: number
}

export interface NotificationRepository {
  /** Avisos del usuario, más recientes primero, páginas de 20, con el total sin leer. */
  listByUser(userId: string, page: number): Promise<{ items: StoredNotification[]; hasNextPage: boolean; unreadCount: number }>
  /**
   * Marca la lectura de un aviso propio y devuelve su estado; conserva la primera lectura.
   * Otro usuario o un id inexistente recibe `null`. No toca compromisos ni ofertas.
   */
  markRead(userId: string, notificationId: string, at: Date): Promise<StoredNotification | null>
}

export interface OutboxRepository {
  /**
   * Reclama hasta `limit` eventos pendientes disponibles en `at` y sin reclamo vigente, por
   * orden de creación, hasta `claimedUntil`. Confirma el reclamo antes de devolverlos, de modo
   * que dos procesos no toman el mismo evento y uno caído lo libera al vencer.
   */
  claim(limit: number, at: Date, claimedUntil: Date): Promise<ClaimedEvent[]>
  /**
   * Genera el aviso de cada destinatario y marca el evento procesado en una misma transacción.
   * El aviso es único por evento y destinatario: repetirlo tras una caída no lo duplica.
   */
  deliver(event: ClaimedEvent, at: Date): Promise<void>
  /** Libera el evento para reintentar en `retryAt`, o lo deja `failed` si `retryAt` es null. */
  release(eventId: string, retryAt: Date | null, errorCode: string): Promise<void>
}
