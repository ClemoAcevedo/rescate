// K030 · HTTP: bandeja de avisos del titular (RF09). Solo transporta; los permisos y la
// lectura idempotente los decide Application.
import { Router } from 'express'
import type { Request } from 'express'
import type { StoredNotification } from '../application/notifications/ports.js'
import type { NotificationUseCases } from '../application/notifications/use-cases.js'
import type { Authenticate } from './actor.js'
import type { HttpSchemas } from './openapi.js'
import { createActorRoute, id, readBody, readPage } from './reservations-router.js'

function notificationBody(notification: StoredNotification): HttpSchemas['Notification'] {
  const { payload } = notification
  return { id: notification.id, kind: notification.kind, createdAt: notification.createdAt.toISOString(),
    readAt: notification.readAt === null ? null : notification.readAt.toISOString(),
    lot: { id: payload.lot.id, description: payload.lot.description }, quantity: payload.quantity,
    waitlistEntryId: payload.waitlistEntryId, reservationId: payload.reservationId, offerExpiresAt: payload.offerExpiresAt }
}

export function createNotificationsRouter(cases: NotificationUseCases, authenticate: Authenticate,
  protectCommand: (request: Request) => Promise<void>, log: (error: unknown) => void = error => console.error(error)): Router {
  const router = Router()
  const withActor = createActorRoute(authenticate, protectCommand, log)

  router.get('/notifications', withActor(async (actor, request, response) => {
    const result = await cases.list(actor, readPage(request.query))
    response.json({ items: result.items.map(notificationBody), page: result.page, hasNextPage: result.hasNextPage,
      unreadCount: result.unreadCount } satisfies HttpSchemas['NotificationPage'])
  }))
  router.post('/notifications/:notificationId/read', withActor(async (actor, request, response) => {
    readBody(request.body, {})
    const notification = await cases.markRead(actor, id(request.params.notificationId))
    response.json(notificationBody(notification) satisfies HttpSchemas['Notification'])
  }))
  return router
}
