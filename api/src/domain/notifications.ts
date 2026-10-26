// K030 · Domain: avisos internos (RF09) y política del outbox. Reglas puras: no conocen
// SQL, HTTP ni el reloj; reciben los instantes y la aleatoriedad como valores.

export const NOTIFICATION_KINDS = ['offer_issued', 'offer_expired', 'reservation_confirmed', 'reservation_cancelled',
  'message_from_holder', 'message_from_establishment'] as const
export type NotificationKind = typeof NOTIFICATION_KINDS[number]

/**
 * Lo que el aviso muestra, tomado bajo el bloqueo de la transición. Identifica la solicitud
 * o la reserva para abrir su detalle, que vuelve a comprobar permisos y estado vigente.
 * Nunca incluye el código de retiro ni datos de otras personas (anexos A p. 2).
 */
export interface NotificationPayload {
  lot: { id: string; description: string }
  quantity: number
  waitlistEntryId: string | null
  reservationId: string | null
  /** Solo en una oferta emitida: hasta cuándo se puede aceptar. */
  offerExpiresAt: string | null
}

/** Evento de una transición, con un destinatario; el worker genera su aviso. */
export interface NotificationEvent {
  kind: NotificationKind
  recipientUserId: string
  payload: NotificationPayload
}

/** Anexos I p. 27: tandas recuperables de hasta 50 destinatarios. */
export const OUTBOX_BATCH_SIZE = 50
/** Reclamo de una tanda: si el worker cae, otro proceso la retoma al vencer. */
export const OUTBOX_LEASE_MS = 120_000
/** Tras estos intentos el evento queda `failed`, visible para revisión (anexos H p. 20). */
export const OUTBOX_MAX_ATTEMPTS = 5

/**
 * Espera antes de reintentar: crece al doble por intento desde 2 s, con tope de 5 min y
 * variación de ±20 % para que procesos reiniciados no reintenten a la vez.
 * `random` es un valor en [0, 1).
 */
export function retryDelayMs(attempts: number, random: number): number {
  const base = Math.min(2_000 * 2 ** Math.max(0, attempts - 1), 300_000)
  return Math.round(base * (0.8 + 0.4 * random))
}

/** Resultado de un intento fallido: reintentar más tarde o dejarlo visible como fallo. */
export function nextAttempt(attempts: number, now: Date, random: number): { retryAt: Date } | { failed: true } {
  if (attempts >= OUTBOX_MAX_ATTEMPTS) return { failed: true }
  return { retryAt: new Date(now.getTime() + retryDelayMs(attempts, random)) }
}
