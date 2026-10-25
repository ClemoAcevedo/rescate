// K030 · Application: bandeja de avisos del titular (RF09) y procesamiento del outbox.
// Leer un aviso solo registra la lectura: no reactiva ofertas ni reservas (anexos A p. 2).
import { notificationNotFound } from '../errors.js'
import type { Actor } from '../lots/ports.js'
import type { NotificationRepository, OutboxRepository } from './ports.js'
import { OUTBOX_BATCH_SIZE, OUTBOX_LEASE_MS, nextAttempt } from '../../domain/notifications.js'
import { errorCode } from '../logging.js'
import type { Log } from '../logging.js'

export function createNotificationUseCases(repository: NotificationRepository, now: () => Date) {
  return {
    async list(actor: Actor, page: number) {
      const result = await repository.listByUser(actor.userId, page)
      return { ...result, page }
    },

    /** Idempotente: la primera lectura se conserva. Un aviso ajeno responde igual que uno inexistente. */
    async markRead(actor: Actor, notificationId: string) {
      const notification = await repository.markRead(actor.userId, notificationId.toLowerCase(), now())
      if (!notification) throw notificationNotFound()
      return notification
    },
  }
}

/**
 * Worker: reclama una tanda, genera los avisos de cada evento y reintenta con espera
 * creciente los que fallen. Devuelve cuántos eventos tomó; 0 indica que no había trabajo.
 */
export function createOutboxProcessor(outbox: OutboxRepository, now: () => Date,
  random: () => number = Math.random, log: Log = () => {}) {
  return {
    async processNext(): Promise<number> {
      const at = now()
      const events = await outbox.claim(OUTBOX_BATCH_SIZE, at, new Date(at.getTime() + OUTBOX_LEASE_MS))
      for (const event of events) {
        try {
          await outbox.deliver(event, now())
        } catch (error) {
          // Sin SQL ni datos personales en el registro; el evento queda para reintento o revisión.
          const code = errorCode(error)
          const decision = nextAttempt(event.attempts, now(), random())
          await outbox.release(event.id, 'retryAt' in decision ? decision.retryAt : null, code)
          log({ event: 'outbox_event_failed', outboxEventId: event.id, attempts: event.attempts, errorCode: code,
            final: !('retryAt' in decision) })
        }
      }
      return events.length
    },
  }
}

export type NotificationUseCases = ReturnType<typeof createNotificationUseCases>
export type OutboxProcessor = ReturnType<typeof createOutboxProcessor>
