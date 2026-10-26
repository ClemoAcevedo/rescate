// K037 · Application · chat de la reserva (RF13). Acá se decide quién participa, si la
// conversación sigue abierta y qué pasa con un reintento. El envío se decide bajo el mismo
// bloqueo del lote que cancelar o retirar, así que no compite de forma incoherente con ellos.
import { idempotencyConflict, reservationNotFound } from '../errors.js'
import type { Actor } from '../lots/ports.js'
import type { ChatRepository, ChatReservation } from './ports.js'
import {
  CHAT_RETENTION_DAYS, MESSAGES_PAGE_SIZE, isConversationOpen, isHistoryRetained, requireMessageText,
  requireOpenConversation,
} from '../../domain/chat.js'
import type { Log } from '../logging.js'

/** Una reserva ajena responde igual que una inexistente para no revelar que existe */
function requireParticipant(reservation: ChatReservation | null): ChatReservation {
  if (!reservation?.participation) throw reservationNotFound()
  return reservation
}

export function createChatUseCases(repository: ChatRepository, now: () => Date) {
  return {
    /**
     * Historial desde la secuencia `after`, que sirve tanto para paginar como para la consulta
     * periódica. Sigue disponible después del cierre y hasta que vence la retención.
     */
    async list(actor: Actor, reservationId: string, after: number) {
      const id = reservationId.toLowerCase()
      const reservation = requireParticipant(await repository.findReservation(actor.userId, id))
      const at = now()
      const open = isConversationOpen(reservation, at)
      if (!isHistoryRetained(reservation, at)) return { items: [], hasMore: false, open }
      const found = await repository.listMessages(actor.userId, id, after, MESSAGES_PAGE_SIZE + 1)
      return { items: found.slice(0, MESSAGES_PAGE_SIZE), hasMore: found.length > MESSAGES_PAGE_SIZE, open }
    },

    /**
     * Repetir la misma clave devuelve el mensaje original aunque la conversación ya haya
     * cerrado. Usarla con otro texto u otra reserva es un conflicto.
     */
    async send(actor: Actor, reservationId: string, input: string, idempotencyKey: string) {
      const text = requireMessageText(input)
      const id = reservationId.toLowerCase()
      return repository.withSendTransaction(actor.userId, id, idempotencyKey.toLowerCase(), text, async (state, writer) => {
        if (state.existing) {
          const { reservationId: sentTo, textMatches, ...sent } = state.existing
          if (sentTo !== id || !textMatches) throw idempotencyConflict()
          return sent
        }
        if (!state.reservation) throw reservationNotFound()
        // La participación se vuelve a mirar porque pudo cambiar mientras se esperaba el bloqueo
        const { participation } = requireParticipant(state.reservation)
        requireOpenConversation(state.reservation, state.now)
        // Se avisa a la otra parte, así que lo que escribe un operador no le llega a sus compañeros
        return writer.append(text, state.now, participation === 'holder' ? 'operators' : 'holder')
      })
    },
  }
}

/** Worker · borrado diario del texto de las conversaciones cerradas hace más de treinta días */
export function createChatRetention(repository: ChatRepository, log: Log) {
  return {
    async eraseExpired(): Promise<number> {
      const erased = await repository.eraseExpired(CHAT_RETENTION_DAYS)
      log({ event: 'chat_retention', erasedMessages: erased })
      return erased
    },
  }
}

export type ChatUseCases = ReturnType<typeof createChatUseCases>
export type ChatRetention = ReturnType<typeof createChatRetention>
