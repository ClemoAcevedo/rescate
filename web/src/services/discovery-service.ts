import { ConnectionError, HttpError, UnexpectedResponseError, request } from './http-client'
import type { PublicLot, PublicLotPage, ReservationResponse, ReserveLotRequest } from './openapi'

export type { PublicLot, PublicLotPage, ReservationResponse }
export { HttpError }

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function parseLot(value: unknown): PublicLot {
  if (!record(value) || typeof value.id !== 'string' || typeof value.description !== 'string'
    || typeof value.category !== 'string' || !Number.isInteger(value.quantity) || (value.quantity as number) < 1
    || !Number.isInteger(value.availableQuantity) || (value.availableQuantity as number) < 0
    || (value.availableQuantity as number) > (value.quantity as number) || typeof value.address !== 'string'
    || typeof value.latitude !== 'number' || !Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90
    || typeof value.longitude !== 'number' || !Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180
    || typeof value.timeZone !== 'string' || typeof value.pickupStartsAt !== 'string'
    || typeof value.pickupEndsAt !== 'string' || (value.conditions !== null && typeof value.conditions !== 'string')
    || (value.photoUrl !== null && typeof value.photoUrl !== 'string')
    || (value.distanceKm !== null && (typeof value.distanceKm !== 'number'
      || !Number.isFinite(value.distanceKm) || value.distanceKm < 0))) throw new Error('El lote público tiene un formato inesperado.')
  return value as unknown as PublicLot
}
function parsePage(value: unknown): PublicLotPage {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 12
    || !Number.isInteger(value.page) || (value.page as number) < 1
    || typeof value.hasNextPage !== 'boolean') throw new Error('La búsqueda tiene un formato inesperado.')
  return { items: value.items.map(parseLot), page: value.page as number, hasNextPage: value.hasNextPage }
}
function parseReservation(value: unknown): ReservationResponse {
  if (!record(value) || typeof value.id !== 'string' || typeof value.lotId !== 'string'
    || !Number.isInteger(value.quantity) || value.status !== 'confirmed' || typeof value.createdAt !== 'string') {
    throw new Error('La reserva tiene un formato inesperado.')
  }
  return value as unknown as ReservationResponse
}
async function send<T>(path: string, parse: (body: unknown) => T, options: { method?: 'GET' | 'POST'; body?: unknown; csrfToken?: string; signal?: AbortSignal } = {}): Promise<T> {
  const result = await request({ path, method: options.method, body: options.body, signal: options.signal,
    headers: options.csrfToken ? { 'X-CSRF-Token': options.csrfToken } : undefined, parse })
  if (result === undefined) throw new UnexpectedResponseError('La API no devolvió contenido.', undefined)
  return result
}

export function searchPublicLots(search: string, signal?: AbortSignal): Promise<PublicLotPage> {
  return send(`/public/lots${search}`, parsePage, { signal })
}
export function getPublicLot(lotId: string, signal?: AbortSignal): Promise<PublicLot> {
  return send(`/public/lots/${encodeURIComponent(lotId)}`, parseLot, { signal })
}
export function uncertainReservation(error: unknown): boolean {
  return error instanceof ConnectionError || error instanceof UnexpectedResponseError
    || (error instanceof HttpError && error.status >= 500)
}

export async function reserveLot(lotId: string, body: ReserveLotRequest, csrfToken: string): Promise<ReservationResponse> {
  // E1 H: hasta 10 s por intento y tres reintentos a 1, 2 y 4 s, misma intención.
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(`/public/lots/${encodeURIComponent(lotId)}/reservations`, parseReservation,
        { method: 'POST', body, csrfToken, signal: AbortSignal.timeout(10000) })
    } catch (error) {
      if (attempt === 3 || !uncertainReservation(error)) throw error
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt))
    }
  }
}

export function discoveryError(error: unknown): string {
  if (error instanceof ConnectionError || error instanceof TypeError) return 'No fue posible conectar con el servicio. Revisa tu conexión e inténtalo nuevamente.'
  if (error instanceof UnexpectedResponseError) return 'El servicio respondió de una forma inesperada. Inténtalo nuevamente más tarde.'
  if (error instanceof HttpError) {
    if (error.status === 404) return 'El lote no existe o dejó de estar disponible.'
    if (error.status === 401) return 'Tu sesión venció. Inicia sesión nuevamente.'
    if (error.status === 409) return 'No hay packs suficientes o ya tienes una reserva activa de este lote. Actualiza el detalle antes de continuar.'
    if (error.status === 403) return 'La solicitud fue rechazada por seguridad. Recarga la página e inténtalo nuevamente.'
    if (error.status === 429) return 'Hay demasiadas solicitudes. Espera un momento antes de reintentar.'
    if (error.status === 422) return 'Revisa los filtros o la cantidad solicitada.'
  }
  return 'No fue posible completar la solicitud. Inténtalo nuevamente más tarde.'
}
