import {
  ConnectionError,
  HttpError,
  UnexpectedResponseError,
  request,
  type ResponseParser,
} from './http-client'
import type {
  CreateLotDraftRequest,
  ErrorResponse,
  LotResponse,
  PublishLotDraftRequest,
  UpdateLotDraftRequest,
  ValidationIssue,
} from './openapi'

export type { CreateLotDraftRequest, LotResponse, UpdateLotDraftRequest }
export type LotErrorCode = ErrorResponse['error']['code']
export type LotError = { code: LotErrorCode; message: string; issues: ValidationIssue[] }

export class LotRequestError extends Error {
  readonly kind = 'lot-request'
  readonly error: LotError
  readonly status: number

  constructor(error: LotError, status: number) {
    super(error.message)
    this.name = 'LotRequestError'
    this.error = error
    this.status = status
  }
}

const errorCodes = new Set<LotErrorCode>([
  'MALFORMED_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT',
  'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'VALIDATION_ERROR', 'RATE_LIMITED',
  'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE',
])

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
  if (status !== 'draft' && status !== 'published') throw new Error('La respuesta del lote no contiene un estado válido.')
  const conditions = value.conditions
  if (conditions !== null && typeof conditions !== 'string') throw new Error('La respuesta del lote no contiene condiciones válidas.')
  const publishedAt = value.publishedAt
  // OpenAPI: publishedAt es null en borrador y un instante en publicado.
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

async function send(path: string, method: 'GET' | 'POST' | 'PATCH', options: { body?: unknown; csrfToken?: string; signal?: AbortSignal }): Promise<LotResponse> {
  try {
    const lot = await request({
      path,
      method,
      body: options.body,
      headers: options.csrfToken ? { 'X-CSRF-Token': options.csrfToken } : undefined,
      parse: parseLotResponse,
      signal: options.signal,
    })
    if (lot === undefined) throw new UnexpectedResponseError('La API no devolvió el lote.', undefined)
    return lot
  } catch (error) {
    if (error instanceof HttpError) {
      const lotError = parseError(error.body)
      if (lotError) throw new LotRequestError(lotError, error.status)
    }
    throw error
  }
}

const lotPath = (lotId: string) => `/lots/${encodeURIComponent(lotId)}`

export function createLotDraft(establishmentId: string, body: CreateLotDraftRequest, csrfToken: string): Promise<LotResponse> {
  return send(`/establishments/${encodeURIComponent(establishmentId)}/lots`, 'POST', { body, csrfToken })
}

export function getLot(lotId: string, signal?: AbortSignal): Promise<LotResponse> {
  return send(lotPath(lotId), 'GET', { signal })
}

export function updateLotDraft(lotId: string, body: UpdateLotDraftRequest, csrfToken: string): Promise<LotResponse> {
  return send(lotPath(lotId), 'PATCH', { body, csrfToken })
}

export function publishLotDraft(lotId: string, body: PublishLotDraftRequest, csrfToken: string): Promise<LotResponse> {
  return send(`${lotPath(lotId)}/publish`, 'POST', { body, csrfToken })
}

export { ConnectionError, UnexpectedResponseError }
