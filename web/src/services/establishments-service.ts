import { HttpError, request, UnexpectedResponseError } from './http-client'
import type { OperableEstablishmentDetails, OperableEstablishmentPage } from './openapi'
import { isValidTimeZone } from '../lots/lot-time'

export type { OperableEstablishmentDetails, OperableEstablishmentPage }

function parseDetails(value: unknown): OperableEstablishmentDetails {
  if (!value || typeof value !== 'object') throw new Error('El establecimiento no tiene el formato esperado.')
  const item = value as Record<string, unknown>
  if (['id', 'name', 'address', 'timeZone'].some(key => typeof item[key] !== 'string' || !item[key])
    || typeof item.latitude !== 'number' || !Number.isFinite(item.latitude) || Math.abs(item.latitude) > 90
    || typeof item.longitude !== 'number' || !Number.isFinite(item.longitude) || Math.abs(item.longitude) > 180) {
    throw new Error('El establecimiento no contiene datos de retiro válidos.')
  }
  if (!isValidTimeZone(item.timeZone as string)) throw new Error('La zona del establecimiento no es válida.')
  return item as unknown as OperableEstablishmentDetails
}

export async function getEstablishment(id: string, signal?: AbortSignal): Promise<OperableEstablishmentDetails> {
  const result = await request({ path: `/establishments/${encodeURIComponent(id)}`, parse: parseDetails, signal })
  if (!result) throw new UnexpectedResponseError('La API no devolvió el establecimiento.', undefined)
  return result
}

export async function searchEstablishments(query: string, page: number, signal?: AbortSignal): Promise<OperableEstablishmentPage> {
  const params = new URLSearchParams({ query, page: String(page) })
  const result = await request({ path: `/establishments?${params}`, signal, parse: value => {
    if (!value || typeof value !== 'object') throw new Error('La búsqueda no tiene el formato esperado.')
    const body = value as Record<string, unknown>
    if (!Array.isArray(body.items) || body.items.length > 20 || body.page !== page || typeof body.hasNextPage !== 'boolean') throw new Error('La página de establecimientos no es válida.')
    return { items: body.items.map(parseDetails), page, hasNextPage: body.hasNextPage }
  } })
  if (!result) throw new UnexpectedResponseError('La API no devolvió la búsqueda.', undefined)
  return result
}

export function establishmentError(error: unknown): string {
  return error instanceof HttpError && error.status === 404
    ? 'El establecimiento no existe o tu cuenta ya no puede operarlo.'
    : 'No pudimos consultar los establecimientos. Revisa tu conexión y vuelve a intentarlo.'
}
