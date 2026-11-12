// K030 · HTTP: bandeja de avisos del titular (RF09). Solo transporta; los permisos y la
// lectura idempotente los decide Application.
import { Router } from 'express'
import type { Request } from 'express'
import type { StoredNotification } from '../application/notifications/ports.js'
import type { NotificationUseCases } from '../application/notifications/use-cases.js'
import type { Authenticate } from './actor.js'
import type { HttpSchemas } from './openapi.js'
import { createActorRoute, id, readBody, readPage, InvalidInput } from './reservations-router.js'
import type { Log } from '../application/logging.js'

function notificationBody(notification: StoredNotification): HttpSchemas['Notification'] {
  const { payload } = notification
  return { id: notification.id, kind: notification.kind, createdAt: notification.createdAt.toISOString(),
    readAt: notification.readAt === null ? null : notification.readAt.toISOString(),
    lot: { id: payload.lot.id, description: payload.lot.description }, quantity: payload.quantity,
    waitlistEntryId: payload.waitlistEntryId, reservationId: payload.reservationId, offerExpiresAt: payload.offerExpiresAt, ...(payload.incident ? { incident: {
      id: payload.incident.id, version: payload.incident.version, status: payload.incident.status,
      reason: payload.incident.reason, instructions: payload.incident.instructions,
      relation: payload.incident.relation, lotClosed: payload.incident.lotClosed,
    } } : {}) }
}

export function createNotificationsRouter(cases: NotificationUseCases, authenticate: Authenticate,
  protectCommand: (request: Request) => Promise<void>, log: Log = event => console.error(event)): Router {
  const router = Router()
  const withActor = createActorRoute(authenticate, protectCommand, log)

  router.get('/notifications', withActor(async (actor, request, response) => {
    const { kind, ...pagination } = request.query
    if (kind !== undefined && kind !== 'incident_version') throw new InvalidInput(['kind'])
    const result = await cases.list(actor, readPage(pagination), kind)
    response.json({ items: result.items.map(notificationBody), page: result.page, hasNextPage: result.hasNextPage,
      unreadCount: result.unreadCount } satisfies HttpSchemas['NotificationPage'])
  }))
  router.get('/notifications/:notificationId', withActor(async (actor, request, response) => {
    if (Object.keys(request.query).length) throw new InvalidInput(Object.keys(request.query))
    response.json(notificationBody(await cases.get(actor, id(request.params.notificationId))))
  }))
  router.post('/notifications/:notificationId/read', withActor(async (actor, request, response) => {
    readBody(request.body, {})
    const notification = await cases.markRead(actor, id(request.params.notificationId))
    response.json(notificationBody(notification) satisfies HttpSchemas['Notification'])
  }))
  return router
}
