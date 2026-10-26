// K027 · HTTP: cola FIFO y ofertas del titular. Ingreso, consulta, salida, aceptación y
// rechazo; la reserva que nace al aceptar se consulta en /reservations/{reservationId}.
import { Router } from 'express'
import type { Request } from 'express'
import type { StoredWaitlistEntry } from '../application/waitlist/ports.js'
import type { WaitlistUseCases } from '../application/waitlist/use-cases.js'
import type { Authenticate } from './actor.js'
import type { HttpSchemas } from './openapi.js'
import { createActorRoute, id, InvalidInput, isUuid, readBody, readPage } from './reservations-router.js'
import type { Log } from '../application/logging.js'

const iso = (value: Date | null) => value === null ? null : value.toISOString()

function entryBody(entry: StoredWaitlistEntry): HttpSchemas['WaitlistEntry'] {
  const { lot } = entry
  return { id: entry.id, requestedQuantity: entry.requestedQuantity, status: entry.status,
    offeredQuantity: entry.offeredQuantity, offerExpiresAt: iso(entry.offerExpiresAt), position: entry.position,
    reservationId: entry.reservationId, createdAt: entry.createdAt.toISOString(), endedAt: iso(entry.endedAt),
    lot: { ...lot, pickupStartsAt: lot.pickupStartsAt.toISOString(), pickupEndsAt: lot.pickupEndsAt.toISOString() } }
}

/** `quantity` entero positivo hasta el límite de almacenamiento; la clave es un UUID. */
function readJoin(value: unknown): { quantity: number; idempotencyKey: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidInput([''])
  const body = value as Record<string, unknown>
  const invalid = Object.keys(body).filter(key => !['quantity', 'idempotencyKey'].includes(key))
  if (!Number.isSafeInteger(body.quantity) || Number(body.quantity) < 1 || Number(body.quantity) > 2147483647) invalid.push('quantity')
  if (!isUuid(body.idempotencyKey)) invalid.push('idempotencyKey')
  if (invalid.length) throw new InvalidInput(invalid)
  return { quantity: body.quantity as number, idempotencyKey: body.idempotencyKey as string }
}

export function createWaitlistRouter(cases: WaitlistUseCases, authenticate: Authenticate,
  protectCommand: (request: Request) => Promise<void>, log: Log = event => console.error(event)): Router {
  const router = Router()
  const withActor = createActorRoute(authenticate, protectCommand, log)

  router.post('/public/lots/:lotId/waitlist', withActor(async (actor, request, response) => {
    const payload = readJoin(request.body)
    const entry = await cases.join(actor, id(request.params.lotId), payload.quantity, payload.idempotencyKey)
    response.status(201).json(entryBody(entry) satisfies HttpSchemas['WaitlistEntry'])
  }))
  router.get('/waitlist', withActor(async (actor, request, response) => {
    const result = await cases.list(actor, readPage(request.query))
    response.json({ items: result.items.map(entryBody), page: result.page, hasNextPage: result.hasNextPage } satisfies HttpSchemas['WaitlistPage'])
  }))
  router.get('/waitlist/:entryId', withActor(async (actor, request, response) => {
    response.json(entryBody(await cases.get(actor, id(request.params.entryId))) satisfies HttpSchemas['WaitlistEntry'])
  }))
  for (const command of ['accept', 'decline', 'leave'] as const) {
    router.post(`/waitlist/:entryId/${command}`, withActor(async (actor, request, response) => {
      readBody(request.body, {})
      response.json(entryBody(await cases[command](actor, id(request.params.entryId))) satisfies HttpSchemas['WaitlistEntry'])
    }))
  }
  return router
}
