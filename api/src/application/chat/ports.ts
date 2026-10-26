// K037 · Application · límites hacia Infrastructure para el chat de la reserva (RF13).
// No exponen pg ni SQL y tampoco deciden quién puede leer o escribir.

/** Cómo participa el actor en la reserva. El titular manda aunque además sea operador del lote */
export type Participation = 'holder' | 'operator' | null

/** Reserva vista desde el chat, con lo justo para saber si la conversación sigue abierta */
export interface ChatReservation {
  participation: Participation
  endedAt: Date | null
  pickupEndsAt: Date
  lotClosedAt: Date | null
}

export interface StoredMessage {
  id: string
  sequence: number
  /** Quién lo escribió respecto de la reserva. Nunca se expone la identidad del operador */
  author: 'holder' | 'operator'
  mine: boolean
  text: string
  createdAt: Date
}

/** Resultado de un envío, que se conserva sin el texto cuando vence la retención */
export interface SentMessage {
  id: string
  sequence: number
  createdAt: Date
}

export interface MessageWriter {
  /** Guarda el mensaje con la siguiente secuencia de la reserva */
  append(text: string, at: Date): Promise<SentMessage>
}

/**
 * Lo que Application necesita para decidir un envío. Si la clave ya se usó llega su
 * resultado. Si no, llega la reserva releída bajo el bloqueo del lote con el reloj de la base,
 * o null cuando no existe o el actor no participa, y en ese caso el lote ni se bloquea.
 */
export type SendState =
  | { existing: SentMessage & { reservationId: string; textMatches: boolean } }
  | { existing: null; reservation: null }
  | { existing: null; reservation: ChatReservation; now: Date }

export interface ChatRepository {
  /** Reserva vista por el actor. Una inexistente da null */
  findReservation(userId: string, reservationId: string): Promise<ChatReservation | null>
  /** Mensajes con secuencia mayor que `after`, en orden, hasta `limit` */
  listMessages(userId: string, reservationId: string, after: number, limit: number): Promise<StoredMessage[]>
  /** Serializa la clave del autor y luego bloquea el lote de la reserva para decidir el envío */
  withSendTransaction<T>(userId: string, reservationId: string, idempotencyKey: string, text: string,
    operate: (state: SendState, writer: MessageWriter) => Promise<T>): Promise<T>
  /** Borra el texto de las conversaciones que cerraron hace más de `retentionDays`, con el reloj de la base */
  eraseExpired(retentionDays: number): Promise<number>
}
