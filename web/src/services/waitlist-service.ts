import { HttpError, UnexpectedResponseError, request } from './http-client'
import type { JoinWaitlistRequest, WaitlistEntry, WaitlistPage } from './openapi'
import { isValidTimeZone } from '../lots/lot-time'

export type { WaitlistEntry }
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const instant = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 2147483647
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0
export function parseEntry(v: unknown): WaitlistEntry {
  if (!record(v) || !id(v.id) || !positive(v.requestedQuantity)
    || !['waiting', 'offered', 'accepted', 'declined', 'expired', 'left'].includes(String(v.status))
    || !instant(v.createdAt) || !record(v.lot)) throw new Error('Solicitud inesperada.')
  const open = v.status === 'waiting' || v.status === 'offered'
  if (open ? v.endedAt !== null : !instant(v.endedAt)) throw new Error('Término incoherente.')
  if (v.status === 'waiting' ? !positive(v.position) : v.position !== null) throw new Error('Posición incoherente.')
  if (v.status === 'accepted' ? !id(v.reservationId) : v.reservationId !== null) throw new Error('Reserva incoherente.')
  if (v.offeredQuantity === null ? v.offerExpiresAt !== null : !positive(v.offeredQuantity) || v.offeredQuantity > v.requestedQuantity || !instant(v.offerExpiresAt)) throw new Error('Oferta incoherente.')
  if (['offered', 'accepted', 'declined'].includes(String(v.status)) && v.offeredQuantity === null) throw new Error('Falta la oferta.')
  if (['waiting', 'left'].includes(String(v.status)) && v.offeredQuantity !== null) throw new Error('Oferta inesperada.')
  const lot = v.lot
  if (!id(lot.id) || typeof lot.description !== 'string' || typeof lot.address !== 'string'
    || !(lot.conditions === null || typeof lot.conditions === 'string')
    || typeof lot.latitude !== 'number' || !Number.isFinite(lot.latitude) || Math.abs(lot.latitude) > 90
    || typeof lot.longitude !== 'number' || !Number.isFinite(lot.longitude) || Math.abs(lot.longitude) > 180
    || typeof lot.timeZone !== 'string' || !isValidTimeZone(lot.timeZone)
    || !instant(lot.pickupStartsAt) || !instant(lot.pickupEndsAt) || Date.parse(lot.pickupStartsAt) >= Date.parse(lot.pickupEndsAt)
    || (instant(v.offerExpiresAt) && Date.parse(v.offerExpiresAt) > Date.parse(lot.pickupEndsAt))) throw new Error('Lote inesperado.')
  return v as unknown as WaitlistEntry
}
async function send<T>(path: string, parse: (v: unknown) => T, options: { method?: 'POST'; body?: object; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  const result = await request({ path, parse, ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) })
  if (!result) throw new UnexpectedResponseError('Respuesta vacía.', undefined)
  return result
}
export function joinWaitlist(lotId: string, input: JoinWaitlistRequest, csrfToken: string) {
  return send(`/public/lots/${encodeURIComponent(lotId)}/waitlist`, v => {
    const entry = parseEntry(v)
    if (entry.lot.id !== lotId || entry.requestedQuantity !== input.quantity) throw new Error('Solicitud distinta.')
    return entry
  }, { method: 'POST', body: input, headers: { 'X-CSRF-Token': csrfToken } })
}
export function getWaitlistEntry(entryId: string, signal?: AbortSignal) {
  return send(`/waitlist/${encodeURIComponent(entryId)}`, v => {
    const entry = parseEntry(v)
    if (entry.id !== entryId) throw new Error('Solicitud distinta.')
    return entry
  }, { signal })
}
export function listWaitlist(page: number, signal?: AbortSignal): Promise<WaitlistPage> {
  return send(`/waitlist?page=${page}`, v => {
    if (!record(v) || !Array.isArray(v.items) || v.items.length > 20 || v.page !== page || typeof v.hasNextPage !== 'boolean') throw new Error('Listado inesperado.')
    return { items: v.items.map(parseEntry), page, hasNextPage: v.hasNextPage }
  }, { signal })
}
export function commandWaitlist(entryId: string, command: 'accept' | 'decline' | 'leave', csrfToken: string) {
  return send(`/waitlist/${encodeURIComponent(entryId)}/${command}`, v => {
    const entry = parseEntry(v)
    if (entry.id !== entryId || entry.status !== { accept: 'accepted', decline: 'declined', leave: 'left' }[command]) throw new Error('Acción sin confirmar.')
    return entry
  }, { method: 'POST', body: {}, headers: { 'X-CSRF-Token': csrfToken } })
}
export function waitlistError(error: unknown) {
  if (error instanceof HttpError) {
    if (error.status === 401) return 'Tu sesión venció. Inicia sesión nuevamente.'
    if (error.status === 403) return 'La solicitud fue rechazada por seguridad. Recarga la página.'
    if (error.status === 404) return 'La solicitud o el lote no existe o no está disponible para tu cuenta.'
    if (error.status === 409) return 'El estado cambió o la acción no está disponible. Consulta el estado vigente. Para ingresar, revisa si puedes reservar directamente o si ya tienes una solicitud o reserva del lote.'
    if (error.status === 422) return 'Revisa la cantidad solicitada.'
    if (error.status === 429) return 'Hay demasiadas solicitudes. Espera antes de reintentar.'
  }
  return 'No se recibió una respuesta válida. Consulta el estado antes de continuar.'
}
