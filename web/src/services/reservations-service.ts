import { ConnectionError, HttpError, UnexpectedResponseError, request } from './http-client'
import type { PickupResponse, PickupReview, ReservationDetail, ReservationPage, ReservationSummary, ReviewedReservation } from './openapi'
import { isValidTimeZone } from '../lots/lot-time'

export type { PickupResponse, PickupReview, ReservationDetail, ReservationSummary, ReviewedReservation }
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

const statuses = ['confirmed', 'cancelled', 'expired', 'delivered']
const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1

function reviewed(value: unknown): ReviewedReservation {
  if (!record(value) || typeof value.id !== 'string' || !value.id || !positiveInteger(value.quantity)
    || !statuses.includes(String(value.status)) || !instant(value.createdAt)
    || (value.status === 'confirmed' ? value.endedAt !== null : !instant(value.endedAt))) throw new Error('Reserva revisada inesperada.')
  // Selección explícita: la revisión no transporta datos del titular ni el código.
  return { id: value.id, quantity: value.quantity as number, status: value.status as ReviewedReservation['status'],
    createdAt: value.createdAt, endedAt: value.endedAt as string | null }
}

/** Revisión del operador (K022): muestra la reserva del código sin consumirlo. El código va solo en el cuerpo. */
export function reviewPickupCode(lotId: string, code: string, csrfToken: string): Promise<PickupReview> {
  return send(`/lots/${encodeURIComponent(lotId)}/pickup-reviews`, value => {
    if (!record(value) || typeof value.canConfirm !== 'boolean') throw new Error('Revisión inesperada.')
    const reservation = reviewed(value.reservation)
    if (value.canConfirm && reservation.status !== 'confirmed') throw new Error('Revisión incoherente.')
    return { reservation, canConfirm: value.canConfirm }
  }, { method: 'POST', body: { code }, headers: { 'X-CSRF-Token': csrfToken } })
}

/** Confirmación del retiro: la API vuelve a validar todo bajo bloqueo; la misma clave reproduce el resultado. */
export function confirmPickup(lotId: string, input: { reservationId: string; code: string; idempotencyKey: string }, csrfToken: string): Promise<PickupResponse> {
  return send(`/lots/${encodeURIComponent(lotId)}/pickups`, value => {
    if (!record(value) || value.reservationId !== input.reservationId || !positiveInteger(value.quantity)
      || !instant(value.deliveredAt)) throw new Error('Entrega inesperada.')
    return { reservationId: value.reservationId, quantity: value.quantity as number, deliveredAt: value.deliveredAt }
  }, { method: 'POST', body: input, headers: { 'X-CSRF-Token': csrfToken } })
}

/** Sin respuesta legible, una confirmación pudo haberse registrado: se reintenta con la misma clave. */
export const isUnknownOutcome = (error: unknown) => error instanceof ConnectionError || error instanceof UnexpectedResponseError

export function pickupError(error: unknown, operation: 'review' | 'confirm') {
  if (error instanceof HttpError && error.status === 404) {
    return operation === 'review'
      ? 'El código no corresponde a una reserva de este lote. Revisa que esté bien escrito.'
      : 'El código ya no corresponde a esta reserva del lote. Revísalo de nuevo.'
  }
  if (error instanceof HttpError && error.status === 422) return 'Escribe el código de retiro tal como lo muestra la persona.'
  if (error instanceof HttpError && error.status === 401) return 'Tu sesión venció. Inicia sesión nuevamente.'
  if (error instanceof HttpError && error.status === 403) return 'Acceso denegado: tu cuenta no opera este establecimiento o la solicitud fue rechazada por seguridad. Recarga la página.'
  if (error instanceof HttpError && error.status === 429) return `Hay demasiados intentos. Espera${error.retryAfter ? ` ${error.retryAfter} s` : ' un momento'} antes de reintentar.`
  if (error instanceof HttpError && error.status === 503) return 'El servicio no está disponible temporalmente. Inténtalo nuevamente.'
  return operation === 'confirm'
    ? 'No se recibió una respuesta válida. El retiro podría haberse registrado: reintenta la confirmación, que no duplica la entrega.'
    : 'No fue posible revisar el código. Revisa tu conexión y reintenta.'
}
