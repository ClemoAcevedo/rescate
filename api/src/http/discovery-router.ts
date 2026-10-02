import { Router } from 'express'
import type { Request, Response } from 'express'
import type { createDiscoveryUseCases } from '../application/discovery/use-cases.js'
import type { PublicLot, Reservation, SearchFilters } from '../application/discovery/ports.js'
import { notAuthenticated } from '../application/errors.js'
import type { Authenticate } from './actor.js'
import type { HttpSchemas } from './openapi.js'
import { handleError, sendError } from './errors.js'
import { photoPath } from './photos-router.js'

type Cases = ReturnType<typeof createDiscoveryUseCases>
class InvalidInput extends Error { constructor(readonly fields: string[]) { super('Entrada inválida') } }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// La búsqueda usa la miniatura; el detalle, la imagen de presentación.
function publicBody(lot: PublicLot, variant: 'thumbnail' | 'display'): HttpSchemas['PublicLot'] {
  const { photoId, photos, ...fields } = lot
  return { ...fields, pickupStartsAt: lot.pickupStartsAt.toISOString(), pickupEndsAt: lot.pickupEndsAt.toISOString(),
    photoUrl: photoId === null ? null : photoPath(lot.id, photoId, variant),
    photos: photos.map(photo => ({ ...photo, thumbnailUrl: photoPath(lot.id, photo.id, 'thumbnail'),
      displayUrl: photoPath(lot.id, photo.id, 'display') })) }
}
function reservationBody(reservation: Reservation): HttpSchemas['ReservationResponse'] {
  return { id: reservation.id, lotId: reservation.lotId, quantity: reservation.quantity,
    status: 'confirmed', createdAt: reservation.createdAt.toISOString() }
}
function parseSearch(request: Request): SearchFilters {
  const allowed = ['category', 'latitude', 'longitude', 'radiusKm', 'pickupBefore', 'page']
  const invalid = Object.keys(request.query).filter(key => !allowed.includes(key))
  const q = (key: string): string | undefined => {
    const value = request.query[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !value.trim()) { invalid.push(key); return undefined }
    return value
  }
  const category = q('category')
  const latitudeText = q('latitude'); const longitudeText = q('longitude'); const radiusText = q('radiusKm')
  const beforeText = q('pickupBefore'); const pageText = q('page')
  const number = (value: string | undefined, field: string, min: number, max: number) => {
    if (value === undefined) return undefined
    const parsed = Number(value)
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
      || !Number.isFinite(parsed) || parsed < min || parsed > max) invalid.push(field)
    return parsed
  }
  const latitude = number(latitudeText, 'latitude', -90, 90)
  const longitude = number(longitudeText, 'longitude', -180, 180)
  const radiusKm = number(radiusText, 'radiusKm', Number.EPSILON, 100)
  const page = number(pageText, 'page', 1, 1000) ?? 1
  if (!Number.isSafeInteger(page)) invalid.push('page')
  if ((latitude === undefined) !== (longitude === undefined)) invalid.push('latitude', 'longitude')
  if (radiusKm !== undefined && latitude === undefined) invalid.push('radiusKm')
  if (category !== undefined && (!category.trim() || category.length > 100)) invalid.push('category')
  let pickupBefore: Date | undefined
  if (beforeText !== undefined) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(beforeText)
    const days = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate() : 0
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[3]) < 1
      || Number(match[3]) > days || Number(match[4]) > 23 || Number(match[5]) > 59
      || Number(match[6]) > 59 || (match[7] !== 'Z' && (Number(match[8]) > 23 || Number(match[9]) > 59))
      || !Number.isFinite(Date.parse(beforeText))) invalid.push('pickupBefore')
    else pickupBefore = new Date(beforeText)
  }
  if (invalid.length) throw new InvalidInput([...new Set(invalid)])
  return { category: category?.trim(), latitude, longitude, radiusKm, pickupBefore, page }
}
function parseReservation(value: unknown): { quantity: number; idempotencyKey: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidInput([''])
  const body = value as Record<string, unknown>
  const invalid = Object.keys(body).filter(key => !['quantity', 'idempotencyKey'].includes(key))
  if (!Number.isSafeInteger(body.quantity) || Number(body.quantity) < 1) invalid.push('quantity')
  if (typeof body.idempotencyKey !== 'string' || !uuid.test(body.idempotencyKey)) invalid.push('idempotencyKey')
  if (invalid.length) throw new InvalidInput(invalid)
  return { quantity: body.quantity as number, idempotencyKey: body.idempotencyKey as string }
}
const id = (value: unknown) => typeof value === 'string' ? value : ''

export function createDiscoveryRouter(cases: Cases, authenticate: Authenticate,
  protectCommand: (request: Request) => Promise<void>, log: (error: unknown) => void = console.error): Router {
  const router = Router()
  const route = (handler: (request: Request, response: Response) => Promise<void>) =>
    async (request: Request, response: Response) => {
      try { await handler(request, response) }
      catch (error) {
        if (error instanceof InvalidInput) sendError(response, 422, 'VALIDATION_ERROR', 'Revisa los campos indicados.',
          error.fields.map(field => ({ path: field ? `/${field}` : '', message: 'Campo ausente o inválido.' })))
        else handleError(error, response, log)
      }
    }
  router.get('/public/lots', route(async (request, response) => {
    const result = await cases.search(parseSearch(request))
    response.json({ items: result.items.map(lot => publicBody(lot, 'thumbnail')), page: result.page, hasNextPage: result.hasNextPage } satisfies HttpSchemas['PublicLotPage'])
  }))
  router.get('/public/lots/:lotId', route(async (request, response) => {
    response.json(publicBody(await cases.get(id(request.params.lotId)), 'display'))
  }))
  router.post('/public/lots/:lotId/reservations', route(async (request, response) => {
    const actor = await authenticate(request)
    if (!actor) throw notAuthenticated()
    await protectCommand(request)
    if (!request.is('application/json')) { sendError(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Se requiere application/json.'); return }
    const payload = parseReservation(request.body)
    const result = await cases.reserve(actor, id(request.params.lotId), payload.quantity, payload.idempotencyKey)
    response.status(201).json(reservationBody(result))
  }))
  return router
}
