import { HttpError, UnexpectedResponseError, request } from './http-client'
import type { ReservationDetail, ReservationPage, ReservationSummary } from './openapi'
import { isValidTimeZone } from '../lots/lot-time'

export type { ReservationDetail, ReservationSummary }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))

function summary(value: unknown): ReservationSummary {
  if (!record(value) || typeof value.id !== 'string' || !value.id
    || !Number.isSafeInteger(value.quantity) || (value.quantity as number) < 1
    || !['confirmed', 'cancelled', 'expired', 'delivered'].includes(String(value.status))
    || !instant(value.createdAt) || !(value.endedAt === null || instant(value.endedAt))
    || (value.status === 'confirmed' ? value.endedAt !== null : value.endedAt === null)
    || !record(value.lot)) throw new Error('Reserva inesperada.')
  const lot = value.lot
  if (typeof lot.id !== 'string' || typeof lot.description !== 'string' || typeof lot.address !== 'string'
    || !(lot.conditions === null || typeof lot.conditions === 'string')
    || typeof lot.latitude !== 'number' || !Number.isFinite(lot.latitude) || Math.abs(lot.latitude) > 90
    || typeof lot.longitude !== 'number' || !Number.isFinite(lot.longitude) || Math.abs(lot.longitude) > 180
    || typeof lot.timeZone !== 'string' || !isValidTimeZone(lot.timeZone)
    || !instant(lot.pickupStartsAt) || !instant(lot.pickupEndsAt)
    || Date.parse(lot.pickupStartsAt) >= Date.parse(lot.pickupEndsAt)) throw new Error('Lote de reserva inesperado.')
  // Selección explícita: los listados nunca transportan el código a la vista.
  return { id: value.id, quantity: value.quantity as number, status: value.status as ReservationSummary['status'],
    createdAt: value.createdAt, endedAt: value.endedAt, lot: lot as unknown as ReservationSummary['lot'] }
}
function detail(value: unknown): ReservationDetail {
  const parsed = summary(value)
  if (!record(value) || (parsed.status === 'confirmed'
    ? typeof value.pickupCode !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{8}$/.test(value.pickupCode)
    : value.pickupCode !== null)) throw new Error('Código de reserva inesperado.')
  return { ...parsed, pickupCode: value.pickupCode as string | null }
}
async function send<T>(path: string, parse: (value: unknown) => T, options: { method?: 'POST'; body?: object; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  const result = await request({ path, parse, ...options, signal: options.signal ?? AbortSignal.timeout(10000) })
  if (result === undefined) throw new UnexpectedResponseError('Respuesta vacía.', undefined)
  return result
}
export function listReservations(page: number, signal?: AbortSignal): Promise<ReservationPage> {
  return send(`/reservations?page=${page}`, value => {
    if (!record(value) || !Array.isArray(value.items) || value.items.length > 20
      || !Number.isSafeInteger(value.page) || value.page !== page || typeof value.hasNextPage !== 'boolean') throw new Error('Listado inesperado.')
    return { items: value.items.map(summary), page, hasNextPage: value.hasNextPage }
  }, { signal })
}
export function getReservation(id: string, signal?: AbortSignal) {
  return send(`/reservations/${encodeURIComponent(id)}`, value => {
    const parsed = detail(value)
    if (parsed.id !== id) throw new Error('Reserva distinta de la solicitada.')
    return parsed
  }, { signal })
}
export function cancelReservation(id: string, csrfToken: string) {
  return send(`/reservations/${encodeURIComponent(id)}/cancel`, value => {
    const parsed = detail(value)
    if (parsed.id !== id || parsed.status !== 'cancelled') throw new Error('Cancelación sin confirmar.')
    return parsed
  }, { method: 'POST', body: {}, headers: { 'X-CSRF-Token': csrfToken } })
}
export function reservationError(error: unknown) {
  if (error instanceof HttpError && error.status === 404) return 'La reserva no existe o no pertenece a tu cuenta.'
  if (error instanceof HttpError && error.status === 409) return 'La reserva ya terminó. Consulta su estado actualizado.'
  if (error instanceof HttpError && error.status === 401) return 'Tu sesión venció. Inicia sesión nuevamente.'
  if (error instanceof HttpError && error.status === 403) return 'La solicitud fue rechazada por seguridad. Recarga la página.'
  if (error instanceof HttpError && error.status === 429) return 'Hay demasiadas solicitudes. Espera antes de reintentar.'
  return 'No fue posible comprobar la reserva. Revisa tu conexión y reintenta.'
}
