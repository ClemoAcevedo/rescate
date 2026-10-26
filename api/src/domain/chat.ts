// K037 · Domain · chat de la reserva (RF13). Reglas puras que reciben los instantes como
// valores, así que no saben nada de SQL, HTTP ni del reloj.

/** Anexos H p. 20 pide texto plano de hasta 1000 caracteres por mensaje */
export const MESSAGE_MAX_LENGTH = 1000
/** El historial se lee en páginas de 50 mensajes ordenados por secuencia */
export const MESSAGES_PAGE_SIZE = 50
/** El texto se borra treinta días después de que la conversación cierra (anexos H p. 21) */
export const CHAT_RETENTION_DAYS = 30

export class ChatRuleError extends Error {
  constructor(readonly reason: 'invalid_text' | 'closed') {
    super(reason)
  }
}

/** Quita los espacios de los bordes y exige entre 1 y 1000 caracteres, contados como en PostgreSQL */
export function requireMessageText(input: string): string {
  const text = input.trim()
  const length = [...text].length
  if (length < 1 || length > MESSAGE_MAX_LENGTH) throw new ChatRuleError('invalid_text')
  return text
}

interface ConversationContext {
  /** Fin de la reserva, que es null mientras sigue confirmada */
  endedAt: Date | null
  pickupEndsAt: Date
  /** Cierre registrado del lote, que llega al vencer o al retirarlo */
  lotClosedAt: Date | null
}

/**
 * La conversación cierra en lo primero que ocurra entre cancelar o retirar la reserva,
 * el fin de la ventana y el cierre del lote. Por eso una reserva vencida queda cerrada
 * aunque el worker todavía no la registre, igual que en reservas.
 */
export function conversationClosesAt({ endedAt, pickupEndsAt, lotClosedAt }: ConversationContext): Date {
  const candidates = [endedAt, pickupEndsAt, lotClosedAt].filter((value): value is Date => value !== null)
  return new Date(Math.min(...candidates.map(value => value.getTime())))
}

export function isConversationOpen(context: ConversationContext, now: Date): boolean {
  return now < conversationClosesAt(context)
}

/** Solo se escribe en una conversación abierta. Cancelar, vencer o retirar la cierran para siempre */
export function requireOpenConversation(context: ConversationContext, now: Date): void {
  if (!isConversationOpen(context, now)) throw new ChatRuleError('closed')
}

/** Pasado el plazo el historial ya no se muestra, aunque el borrado diario todavía no haya pasado */
export function isHistoryRetained(context: ConversationContext, now: Date): boolean {
  const erasesAt = conversationClosesAt(context).getTime() + CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000
  return now.getTime() < erasesAt
}
