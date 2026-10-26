// K037 · HTTP · chat de la reserva (RF13). Solo transporta y cobra el límite de envíos.
// Quién participa, si la conversación sigue abierta y los reintentos los decide Application.
import { Router } from 'express'
import type { Request } from 'express'
import type { ChatUseCases } from '../application/chat/use-cases.js'
import type { SentMessage, StoredMessage } from '../application/chat/ports.js'
import type { Authenticate } from './actor.js'
import type { HttpSchemas } from './openapi.js'
import type { createTrafficLimits } from './rate-limits.js'
import { InvalidInput, createActorRoute, id, isUuid, readBody } from './reservations-router.js'
import type { Log } from '../application/logging.js'

const sentBody = (message: SentMessage): HttpSchemas['SentMessage'] =>
  ({ id: message.id, sequence: message.sequence, createdAt: message.createdAt.toISOString() })
const messageBody = (message: StoredMessage): HttpSchemas['ChatMessage'] =>
  ({ ...sentBody(message), author: message.author, mine: message.mine, text: message.text })

/** `after` es opcional y parte en 0. Cualquier otro parámetro de consulta se rechaza */
function readAfter(query: Request['query']): number {
  const invalid = Object.keys(query).filter(key => key !== 'after')
  const after = query.after === undefined ? 0
    : typeof query.after === 'string' && /^(0|[1-9]\d{0,9})$/.test(query.after) ? Number(query.after) : -1
  if (after < 0 || after > 2147483647) invalid.push('after')
  if (invalid.length) throw new InvalidInput(invalid)
  return after
}

/** `limits.message` es el cupo de envíos por usuario de anexos H p. 21 */
export function createChatRouter(cases: ChatUseCases, authenticate: Authenticate,
  protectCommand: (request: Request) => Promise<void>, limits: Pick<ReturnType<typeof createTrafficLimits>, 'message'>,
  log: Log = event => console.error(event)): Router {
  const router = Router()
  const withActor = createActorRoute(authenticate, protectCommand, log)

  router.get('/reservations/:reservationId/messages', withActor(async (actor, request, response) => {
    const page = await cases.list(actor, id(request.params.reservationId), readAfter(request.query))
    response.json({ items: page.items.map(messageBody), hasMore: page.hasMore, open: page.open } satisfies HttpSchemas['ChatMessagePage'])
  }))
  router.post('/reservations/:reservationId/messages', withActor(async (actor, request, response) => {
    const body = readBody(request.body, { text: value => typeof value === 'string', idempotencyKey: isUuid })
    limits.message(actor.userId)
    const sent = await cases.send(actor, id(request.params.reservationId), body.text!, body.idempotencyKey!)
    response.status(201).json(sentBody(sent))
  }))
  return router
}
