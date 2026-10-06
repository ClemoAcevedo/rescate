// K022 · HTTP: reservas del titular (consulta y cancelación) y retiro del operador.
// El código viaja solo en cuerpos JSON: nunca en rutas, consultas ni registros.
import { Router } from 'express'
import type { Request, Response } from 'express'
import type { ReservationUseCases } from '../application/reservations/use-cases.js'
import type { ReservationLot } from '../application/reservations/ports.js'
import type { ReservationStatus } from '../domain/reservations.js'
import type { Actor } from '../application/lots/ports.js'
import { notAuthenticated } from '../application/errors.js'
import type { Authenticate } from './actor.js'
import type { HttpSchemas } from './openapi.js'
import { handleError, sendError } from './errors.js'

class InvalidInput extends Error { constructor(readonly fields: string[]) { super('Entrada inválida') } }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const id = (value: unknown) => typeof value === 'string' ? value : ''
const iso = (value: Date | null) => value === null ? null : value.toISOString()

interface ReservationView {
  id: string; quantity: number; status: ReservationStatus; createdAt: Date; endedAt: Date | null
}
function reservationFields(reservation: ReservationView) {
  return { id: reservation.id, quantity: reservation.quantity, status: reservation.status,
    createdAt: reservation.createdAt.toISOString(), endedAt: iso(reservation.endedAt) }
}
function lotBody(lot: ReservationLot): HttpSchemas['ReservationLot'] {
  return { ...lot, pickupStartsAt: lot.pickupStartsAt.toISOString(), pickupEndsAt: lot.pickupEndsAt.toISOString() }
}
function summaryBody(reservation: ReservationView & { lot: ReservationLot }): HttpSchemas['ReservationSummary'] {
  return { ...reservationFields(reservation), lot: lotBody(reservation.lot) }
}

/** Cuerpo JSON con exactamente los campos permitidos; los ausentes o desconocidos se informan. */
function readBody(value: unknown, fields: Record<string, (field: unknown) => boolean>): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidInput([''])
  const body = value as Record<string, unknown>
  const invalid = Object.keys(body).filter(key => !Object.hasOwn(fields, key))
  for (const [field, valid] of Object.entries(fields)) if (!valid(body[field])) invalid.push(field)
  if (invalid.length) throw new InvalidInput(invalid)
  return body as Record<string, string>
}
const isUuid = (value: unknown) => typeof value === 'string' && uuid.test(value)
// Forma estructural: Application normaliza y valida el código sin distinguir sus fallos.
const isCode = (value: unknown) => typeof value === 'string' && value.length >= 1 && value.length <= 32
function readPage(query: Request['query']): number {
  const invalid = Object.keys(query).filter(key => key !== 'page')
  let page = 1
  if (query.page !== undefined) {
    page = typeof query.page === 'string' && /^[1-9]\d{0,3}$/.test(query.page) ? Number(query.page) : 0
    if (page < 1 || page > 1000) invalid.push('page')
  }
  if (invalid.length) throw new InvalidInput(invalid)
  return page
}

export function createReservationsRouter(cases: ReservationUseCases, authenticate: Authenticate,
  protectCommand: (request: Request) => Promise<void>, log: (error: unknown) => void = error => console.error(error)): Router {
  const router = Router()
  const withActor = (handler: (actor: Actor, request: Request, response: Response) => Promise<void>) =>
    async (request: Request, response: Response) => {
      try {
        const actor = await authenticate(request)
        if (!actor) throw notAuthenticated()
        if (request.method !== 'GET') {
          await protectCommand(request)
          if (!request.is('application/json')) { sendError(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Se requiere application/json.'); return }
        }
        await handler(actor, request, response)
      } catch (error) {
        if (error instanceof InvalidInput) sendError(response, 422, 'VALIDATION_ERROR', 'Revisa los campos indicados.',
          error.fields.map(field => ({ path: field ? `/${field.replaceAll('~', '~0').replaceAll('/', '~1')}` : '',
            message: 'Campo desconocido, ausente o con formato inválido.' })))
        else handleError(error, response, log)
      }
    }

  router.get('/reservations', withActor(async (actor, request, response) => {
    const result = await cases.list(actor, readPage(request.query))
    response.json({ items: result.items.map(summaryBody), page: result.page, hasNextPage: result.hasNextPage } satisfies HttpSchemas['ReservationPage'])
  }))
  router.get('/reservations/:reservationId', withActor(async (actor, request, response) => {
    const reservation = await cases.get(actor, id(request.params.reservationId))
    response.json({ ...summaryBody(reservation), pickupCode: reservation.pickupCode } satisfies HttpSchemas['ReservationDetail'])
  }))
  router.post('/reservations/:reservationId/cancel', withActor(async (actor, request, response) => {
    readBody(request.body, {})
    const reservation = await cases.cancel(actor, id(request.params.reservationId))
    response.json({ ...summaryBody(reservation), pickupCode: null } satisfies HttpSchemas['ReservationDetail'])
  }))
  router.post('/lots/:lotId/pickup-reviews', withActor(async (actor, request, response) => {
    const { code } = readBody(request.body, { code: isCode })
    const review = await cases.reviewPickup(actor, id(request.params.lotId), code!)
    response.json({ reservation: reservationFields(review.reservation), canConfirm: review.canConfirm } satisfies HttpSchemas['PickupReview'])
  }))
  router.post('/lots/:lotId/pickups', withActor(async (actor, request, response) => {
    const body = readBody(request.body, { reservationId: isUuid, code: isCode, idempotencyKey: isUuid })
    const delivery = await cases.confirmPickup(actor, id(request.params.lotId), body.reservationId!, body.code!, body.idempotencyKey!)
    response.status(201).json({ reservationId: delivery.reservationId, quantity: delivery.quantity,
      deliveredAt: delivery.deliveredAt.toISOString() } satisfies HttpSchemas['PickupResponse'])
  }))
  return router
}
