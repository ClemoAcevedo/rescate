import {
  ConnectionError,
  HttpError,
  UnexpectedResponseError,
  buildUrl,
  request,
  type ResponseParser,
} from './http-client'
import type {
  LotManagementRequest,
  LotManagementResponse,
  CreateLotDraftRequest,
  ErrorResponse,
  LotPhoto,
  LotPhotoList,
  LotResponse,
  OperatorLotPage,
  OperatorLotSummary,
  PublishLotDraftRequest,
  UpdateLotDraftRequest,
  ValidationIssue,
} from './openapi'

export type { CreateLotDraftRequest, LotPhoto, LotResponse, OperatorLotPage, OperatorLotSummary, UpdateLotDraftRequest }
export type LotErrorCode = ErrorResponse['error']['code']
export type LotError = { code: LotErrorCode; message: string; issues: ValidationIssue[] }

export class LotRequestError extends Error {
  readonly kind = 'lot-request'
  readonly error: LotError
  readonly status: number
  readonly retryAfter: number | null

  constructor(error: LotError, status: number, retryAfter: number | null = null) {
    super(error.message)
    this.name = 'LotRequestError'
    this.error = error
    this.status = status
    this.retryAfter = retryAfter
  }
}

const errorCodes = new Set<LotErrorCode>([
  'MALFORMED_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT',
  'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'VALIDATION_ERROR', 'RATE_LIMITED',
  'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE',
])

const lotStatuses: readonly string[] = ['draft', 'published', 'expired', 'withdrawn'] satisfies LotResponse['status'][]

function isLotStatus(value: unknown): value is LotResponse['status'] {
  return typeof value === 'string' && lotStatuses.includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string') throw new Error(`La respuesta del lote no contiene ${key} válido.`)
  return value[key]
}

function requireNumber(value: Record<string, unknown>, key: string): number {
  if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) throw new Error(`La respuesta del lote no contiene ${key} válido.`)
  return value[key]
}

const parseLotResponse: ResponseParser<LotResponse> = (value) => {
  if (!isRecord(value)) throw new Error('La respuesta del lote no tiene el formato esperado.')
  const status = value.status
  if (!isLotStatus(status)) throw new Error('La respuesta del lote no contiene un estado válido.')
  const conditions = value.conditions
  if (conditions !== null && typeof conditions !== 'string') throw new Error('La respuesta del lote no contiene condiciones válidas.')
  const publishedAt = value.publishedAt
  // OpenAPI: publishedAt es null en borrador y un instante en los demás estados.
  if (status === 'draft' ? publishedAt !== null : typeof publishedAt !== 'string') {
    throw new Error('La respuesta del lote no es coherente con su estado de publicación.')
  }
  if (publishedAt !== null && typeof publishedAt !== 'string') throw new Error('La respuesta del lote no contiene publishedAt válido.')
  return {
    id: requireString(value, 'id'),
    establishmentId: requireString(value, 'establishmentId'),
    description: requireString(value, 'description'),
    category: requireString(value, 'category'),
    quantity: requireNumber(value, 'quantity'),
    conditions,
    address: requireString(value, 'address'),
    latitude: requireNumber(value, 'latitude'),
    longitude: requireNumber(value, 'longitude'),
    timeZone: requireString(value, 'timeZone'),
    pickupStartsAt: requireString(value, 'pickupStartsAt'),
    pickupEndsAt: requireString(value, 'pickupEndsAt'),
    status,
    version: requireNumber(value, 'version'),
    createdAt: requireString(value, 'createdAt'),
    publishedAt,
  }
}

function parseError(value: unknown): LotError | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== 'string'
    || !errorCodes.has(value.error.code as LotErrorCode) || typeof value.error.message !== 'string') return undefined
  const issues = isRecord(value.error.details) && Array.isArray(value.error.details.issues)
    ? value.error.details.issues.flatMap((issue) => isRecord(issue) && typeof issue.path === 'string' && typeof issue.message === 'string'
      ? [{ path: issue.path, message: issue.message }] : [])
    : []
  return { code: value.error.code as LotErrorCode, message: value.error.message, issues }
}

const photoStatuses = new Set<LotPhoto['status']>(['uploading', 'pending', 'ready', 'rejected'])
const rejectionReasons = new Set<NonNullable<LotPhoto['rejectionReason']>>([
  'unsupported_format', 'animated', 'too_many_pixels', 'undecodable', 'output_too_large', 'processing_failed',
])
const nullableString = (value: unknown) => value === null || typeof value === 'string'
const nullableNumber = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value))

function parsePhoto(value: unknown): LotPhoto {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.position !== 'number'
    || !photoStatuses.has(value.status as LotPhoto['status']) || typeof value.createdAt !== 'string'
    || !nullableNumber(value.width) || !nullableNumber(value.height)
    || !(value.rejectionReason === null || rejectionReasons.has(value.rejectionReason as NonNullable<LotPhoto['rejectionReason']>))
    || !nullableString(value.thumbnailUrl) || !nullableString(value.displayUrl)) {
    throw new Error('La respuesta contiene una foto con formato inesperado.')
  }
  return value as unknown as LotPhoto
}

const parsePhotoList: ResponseParser<LotPhotoList> = (value) => {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 50) throw new Error('La lista de fotos no tiene el formato esperado.')
  if (value.limit !== undefined && (!Number.isInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 50)) throw new Error('Cupo de fotos inválido.')
  return { items: value.items.map(parsePhoto), limit: value.limit as number | undefined }
}

function parseSummary(value: unknown): OperatorLotSummary {
  if (!isRecord(value) || typeof value.id !== 'string' || !isLotStatus(value.status)
    || typeof value.description !== 'string' || typeof value.category !== 'string'
    || !Number.isInteger(value.quantity) || !Number.isInteger(value.reservedQuantity) || !Number.isInteger(value.version)
    || typeof value.pickupStartsAt !== 'string' || typeof value.pickupEndsAt !== 'string' || typeof value.timeZone !== 'string'
    || typeof value.createdAt !== 'string' || !nullableString(value.publishedAt) || !nullableString(value.photoUrl)) {
    throw new Error('La lista de lotes contiene un lote con formato inesperado.')
  }
  const lot = value as unknown as OperatorLotSummary
  return { ...lot, photoUrl: lot.photoUrl === null ? null : buildUrl(lot.photoUrl) }
}

const parseLotPage: ResponseParser<OperatorLotPage> = (value) => {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 20
    || !Number.isInteger(value.page) || typeof value.hasNextPage !== 'boolean') throw new Error('La lista de lotes no tiene el formato esperado.')
  return { items: value.items.map(parseSummary), page: value.page as number, hasNextPage: value.hasNextPage }
}

type SendOptions<T> = { body?: unknown; csrfToken?: string; signal?: AbortSignal; parse?: ResponseParser<T> }

async function send<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', options: SendOptions<T>): Promise<T | undefined> {
  try {
    return await request({
      path,
      method,
      body: options.body,
      headers: options.csrfToken ? { 'X-CSRF-Token': options.csrfToken } : undefined,
      parse: options.parse,
      signal: options.signal,
    })
  } catch (error) {
    if (error instanceof HttpError) {
      const lotError = parseError(error.body)
      if (lotError) throw new LotRequestError(lotError, error.status, error.retryAfter)
    }
    throw error
  }
}

async function sendLot(path: string, method: 'GET' | 'POST' | 'PATCH', options: Omit<SendOptions<LotResponse>, 'parse'>): Promise<LotResponse> {
  const lot = await send(path, method, { ...options, parse: parseLotResponse })
  if (lot === undefined) throw new UnexpectedResponseError('La API no devolvió el lote.', undefined)
  return lot
}

const lotPath = (lotId: string) => `/lots/${encodeURIComponent(lotId)}`

export function createLotDraft(establishmentId: string, body: CreateLotDraftRequest, csrfToken: string): Promise<LotResponse> {
  return sendLot(`/establishments/${encodeURIComponent(establishmentId)}/lots`, 'POST', { body, csrfToken })
}

export function getLot(lotId: string, signal?: AbortSignal): Promise<LotResponse> {
  return sendLot(lotPath(lotId), 'GET', { signal })
}

export function updateLotDraft(lotId: string, body: UpdateLotDraftRequest, csrfToken: string): Promise<LotResponse> {
  return sendLot(lotPath(lotId), 'PATCH', { body, csrfToken })
}

export function publishLotDraft(lotId: string, body: PublishLotDraftRequest, csrfToken: string): Promise<LotResponse> {
  return sendLot(`${lotPath(lotId)}/publish`, 'POST', { body, csrfToken })
}

export async function listEstablishmentLots(establishmentId: string, query: { status?: LotResponse['status']; page?: number }, signal?: AbortSignal): Promise<OperatorLotPage> {
  const params = new URLSearchParams()
  if (query.status) params.set('status', query.status)
  if (query.page && query.page > 1) params.set('page', String(query.page))
  const search = params.toString()
  const page = await send(`/establishments/${encodeURIComponent(establishmentId)}/lots${search ? `?${search}` : ''}`, 'GET', { signal, parse: parseLotPage })
  if (page === undefined) throw new UnexpectedResponseError('La API no devolvió los lotes.', undefined)
  return page
}

const photosPath = (lotId: string) => `${lotPath(lotId)}/photos`

export async function listLotPhotos(lotId: string, signal?: AbortSignal): Promise<LotPhoto[]> {
  return (await listLotPhotoPage(lotId, signal)).items
}

export async function listLotPhotoPage(lotId: string, signal?: AbortSignal): Promise<LotPhotoList> {
  const list = await send(photosPath(lotId), 'GET', { signal, parse: parsePhotoList })
  if (list === undefined) throw new UnexpectedResponseError('La API no devolvió las fotos.', undefined)
  return { ...list, items: [...list.items].sort((a, b) => a.position - b.position) }
}

/** El archivo viaja como cuerpo binario con su propio Content-Type (OpenAPI `uploadLotPhoto`). */
export async function uploadLotPhoto(lotId: string, file: File, csrfToken: string): Promise<LotPhoto> {
  const photo = await send(photosPath(lotId), 'POST', { body: file, csrfToken, parse: parsePhoto })
  if (photo === undefined) throw new UnexpectedResponseError('La API no devolvió la foto cargada.', undefined)
  return photo
}

export async function removeLotPhoto(lotId: string, photoId: string, csrfToken: string): Promise<void> {
  await send(`${photosPath(lotId)}/${encodeURIComponent(photoId)}`, 'DELETE', { csrfToken })
}

export { ConnectionError, UnexpectedResponseError }

export type { LotManagementRequest, LotManagementResponse }
const parseManagement: ResponseParser<LotManagementResponse> = value => {
  if (!isRecord(value) || !isLotStatus(value.status) || !Number.isSafeInteger(value.version) || Number(value.version) < 1
      || typeof value.paused !== 'boolean' || !Array.isArray(value.history) || value.history.length > 20
      || ['freeQuantity','offeredQuantity','reservedQuantity','deliveredQuantity','unassignableQuantity']
        .some(key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0)
      || value.history.some(item => !isRecord(item) || typeof item.id !== 'string'
        || !['reduce_stock','pause','resume','withdraw'].includes(String(item.action)) || typeof item.reason !== 'string'
        || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
        || !Number.isSafeInteger(item.version) || (item.quantity !== null && (!Number.isSafeInteger(item.quantity) || Number(item.quantity) < 1)))) {
    throw new Error('El inventario no tiene el formato esperado.')
  }
  return value as unknown as LotManagementResponse
}
export async function getLotManagement(lotId: string, signal?: AbortSignal): Promise<LotManagementResponse> {
  const result = await send(`${lotPath(lotId)}/management`, 'GET', { signal, parse: parseManagement })
  if (!result) throw new UnexpectedResponseError('La API no devolvió el inventario.', undefined)
  return result
}
export async function manageLot(lotId: string, body: LotManagementRequest, csrfToken: string): Promise<LotManagementResponse> {
  const result = await send(`${lotPath(lotId)}/management`, 'POST', { body, csrfToken, parse: parseManagement })
  if (!result) throw new UnexpectedResponseError('La API no devolvió la operación.', undefined)
  return result
}
