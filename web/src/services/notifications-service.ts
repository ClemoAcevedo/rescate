import { HttpError, UnexpectedResponseError, request } from './http-client'
import type { Notification, NotificationPage } from './openapi'

export type { Notification, NotificationPage }
const kinds = ['offer_issued', 'offer_expired', 'reservation_confirmed', 'reservation_cancelled']
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const nullableId = (value: unknown) => value === null || (typeof value === 'string' && value.length > 0)

function notification(value: unknown): Notification {
  if (!record(value) || typeof value.id !== 'string' || !value.id || !kinds.includes(String(value.kind))
    || !instant(value.createdAt) || !(value.readAt === null || instant(value.readAt))
    || !record(value.lot) || typeof value.lot.id !== 'string' || typeof value.lot.description !== 'string'
    || !Number.isSafeInteger(value.quantity) || (value.quantity as number) < 1
    || !nullableId(value.waitlistEntryId) || !nullableId(value.reservationId)
    || !(value.offerExpiresAt === null || instant(value.offerExpiresAt))) throw new Error('Aviso inesperado.')
  // Selección explícita: solo los campos del contrato llegan a la vista.
  return { id: value.id, kind: value.kind as Notification['kind'], createdAt: value.createdAt, readAt: value.readAt,
    lot: { id: value.lot.id, description: value.lot.description }, quantity: value.quantity as number,
    waitlistEntryId: value.waitlistEntryId as string | null, reservationId: value.reservationId as string | null,
    offerExpiresAt: value.offerExpiresAt as string | null }
}

async function send<T>(path: string, parse: (value: unknown) => T, options: { method?: 'POST'; body?: object; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  const result = await request({ path, parse, ...options, signal: options.signal ?? AbortSignal.timeout(10000) })
  if (result === undefined) throw new UnexpectedResponseError('Respuesta vacía.', undefined)
  return result
}

export function listNotifications(page: number, signal?: AbortSignal): Promise<NotificationPage> {
  return send(`/notifications?page=${page}`, value => {
    if (!record(value) || !Array.isArray(value.items) || value.items.length > 20 || value.page !== page
      || typeof value.hasNextPage !== 'boolean' || !Number.isSafeInteger(value.unreadCount) || (value.unreadCount as number) < 0) {
      throw new Error('Bandeja inesperada.')
    }
    return { items: value.items.map(notification), page, hasNextPage: value.hasNextPage, unreadCount: value.unreadCount as number }
  }, { signal })
}

/** Registra la lectura; no cambia ofertas ni reservas (RF09). */
export function markNotificationRead(id: string, csrfToken: string): Promise<Notification> {
  return send(`/notifications/${encodeURIComponent(id)}/read`, value => {
    const parsed = notification(value)
    if (parsed.id !== id || parsed.readAt === null) throw new Error('Lectura sin confirmar.')
    return parsed
  }, { method: 'POST', body: {}, headers: { 'X-CSRF-Token': csrfToken } })
}

export function notificationError(error: unknown) {
  if (error instanceof HttpError && error.status === 401) return 'Tu sesión venció. Inicia sesión nuevamente.'
  if (error instanceof HttpError && error.status === 404) return 'El aviso no existe o no pertenece a tu cuenta.'
  if (error instanceof HttpError && error.status === 403) return 'La solicitud fue rechazada por seguridad. Recarga la página.'
  if (error instanceof HttpError && error.status === 429) return 'Hay demasiadas solicitudes. Espera antes de reintentar.'
  return 'No fue posible consultar tus avisos. Revisa tu conexión; se reintentará al reconectar.'
}
