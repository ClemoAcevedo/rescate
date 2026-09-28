import { ConnectionError, HttpError, UnexpectedResponseError, request } from './http-client'
import type { ErrorResponse, PublicLot, PublicLotPage, ReservationResponse, ReserveLotRequest } from './openapi'

export type { PublicLot, PublicLotPage, ReservationResponse }
export { ConnectionError, UnexpectedResponseError }

export class DiscoveryRequestError extends Error {
  readonly status: number
  readonly code: ErrorResponse['error']['code']
  readonly issues: { path: string; message: string }[]
  constructor(status: number, code: ErrorResponse['error']['code'], issues: { path: string; message: string }[]) {
    super(code)
    this.status = status; this.code = code; this.issues = issues
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function parseLot(value: unknown): PublicLot {
  if (!record(value) || typeof value.id !== 'string' || typeof value.description !== 'string'
    || typeof value.category !== 'string' || !Number.isInteger(value.quantity)
    || !Number.isInteger(value.availableQuantity) || typeof value.address !== 'string'
    || typeof value.latitude !== 'number' || typeof value.longitude !== 'number'
    || typeof value.timeZone !== 'string' || typeof value.pickupStartsAt !== 'string'
    || typeof value.pickupEndsAt !== 'string' || (value.conditions !== null && typeof value.conditions !== 'string')
    || (value.photoUrl !== null && typeof value.photoUrl !== 'string')
    || (value.distanceKm !== null && typeof value.distanceKm !== 'number')) throw new Error('El lote público tiene un formato inesperado.')
  return value as unknown as PublicLot
}
function parsePage(value: unknown): PublicLotPage {
  if (!record(value) || !Array.isArray(value.items) || !Number.isInteger(value.page)
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
  try {
    const result = await request({ path, method: options.method, body: options.body, signal: options.signal,
      headers: options.csrfToken ? { 'X-CSRF-Token': options.csrfToken } : undefined, parse })
    if (result === undefined) throw new UnexpectedResponseError('La API no devolvió contenido.', undefined)
    return result
  } catch (error) {
    if (error instanceof HttpError && record(error.body) && record(error.body.error)
      && typeof error.body.error.code === 'string') {
      const details = error.body.error.details
      const issues = record(details) && Array.isArray(details.issues)
        ? details.issues.flatMap(issue => record(issue) && typeof issue.path === 'string' && typeof issue.message === 'string'
          ? [{ path: issue.path, message: issue.message }] : []) : []
      throw new DiscoveryRequestError(error.status, error.body.error.code as ErrorResponse['error']['code'], issues)
    }
    throw error
  }
}

export function searchPublicLots(search: string, signal?: AbortSignal): Promise<PublicLotPage> {
  return send(`/public/lots${search}`, parsePage, { signal })
}
export function getPublicLot(lotId: string, signal?: AbortSignal): Promise<PublicLot> {
  return send(`/public/lots/${encodeURIComponent(lotId)}`, parseLot, { signal })
}
export function reserveLot(lotId: string, body: ReserveLotRequest, csrfToken: string): Promise<ReservationResponse> {
  return send(`/public/lots/${encodeURIComponent(lotId)}/reservations`, parseReservation,
    { method: 'POST', body, csrfToken })
}

export function discoveryError(error: unknown): string {
  if (error instanceof ConnectionError || error instanceof TypeError) return 'No fue posible conectar con el servicio. Revisa tu conexión e inténtalo nuevamente.'
  if (error instanceof UnexpectedResponseError) return 'El servicio respondió de una forma inesperada. Inténtalo nuevamente más tarde.'
  if (error instanceof DiscoveryRequestError) {
    if (error.code === 'NOT_FOUND') return 'El lote no existe o dejó de estar disponible.'
    if (error.code === 'UNAUTHENTICATED') return 'Tu sesión venció. Inicia sesión nuevamente.'
    if (error.code === 'CONFLICT') return 'No hay packs suficientes o ya tienes una reserva activa de este lote. Actualiza el detalle antes de continuar.'
    if (error.code === 'FORBIDDEN') return 'La solicitud fue rechazada por seguridad. Recarga la página e inténtalo nuevamente.'
    if (error.code === 'RATE_LIMITED') return 'Hay demasiadas solicitudes. Espera un momento antes de reintentar.'
    if (error.code === 'VALIDATION_ERROR') return 'Revisa los filtros o la cantidad solicitada.'
  }
  return 'No fue posible completar la solicitud. Inténtalo nuevamente más tarde.'
}
