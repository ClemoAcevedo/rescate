// K027 · Application: límites hacia Infrastructure para la cola FIFO y las ofertas.
// No exponen pg ni SQL; cada transacción bloquea el lote antes de entregar su estado.
import type { WaitlistStatus } from '../../domain/waitlist.js'
import type { IssuedPickupCode, ReservationLot } from '../reservations/ports.js'

/** Solicitud con su estado almacenado; Application deriva el vencimiento con su instante. */
export interface StoredWaitlistEntry {
  id: string
  requestedQuantity: number
  status: WaitlistStatus
  offeredQuantity: number | null
  offerExpiresAt: Date | null
  /** Lugar en la cola (1 es el primero); solo mientras la solicitud espera. */
  position: number | null
  reservationId: string | null
  createdAt: Date
  endedAt: Date | null
  lot: ReservationLot
}

/** Resultado previo de la clave, o el lote releído bajo bloqueo con el reloj de la base. */
export type JoinState =
  | { existing: StoredWaitlistEntry & { lotId: string } }
  | { existing: null; lot: null }
  | { existing: null; lot: { quantity: number; availableQuantity: number; pickupEndsAt: Date }
      active: boolean; queued: boolean; reconciled: boolean; now: Date }

export interface JoinWriter {
  /**
   * Abre la solicitud al final de la cola y ofrece de inmediato lo que haya libre
   * (ADR 0002). Devuelve la solicitud tal como queda tras esa asignación.
   */
  enqueue(quantity: number, at: Date): Promise<StoredWaitlistEntry>
}

export interface EntryWriter {
  /** RF07: oferta vigente → reserva confirmada por la cantidad ofrecida (O → R). Devuelve su id. */
  accept(code: IssuedPickupCode, at: Date): Promise<string>
  /** Cierra la solicitud, libera lo retenido y ofrece a quien sigue. */
  decline(at: Date): Promise<void>
  /** Retira la solicitud que aún espera; no hay packs que liberar. */
  leave(at: Date): Promise<void>
}

/** Solicitud del titular releída bajo bloqueo, tras registrar los vencimientos pendientes del lote. */
export type EntryState = { entry: StoredWaitlistEntry; now: Date } | null

export interface WaitlistRepository {
  /** Solicitudes del titular, creación descendente, páginas de 20. */
  listByHolder(userId: string, page: number): Promise<{ items: StoredWaitlistEntry[]; hasNextPage: boolean }>
  findByHolder(userId: string, entryId: string): Promise<StoredWaitlistEntry | null>
  /** Serializa la clave por usuario, bloquea el lote y relee cola, inventario y reloj. */
  withJoinTransaction<T>(userId: string, lotId: string, idempotencyKey: string,
    operate: (state: JoinState, writer: JoinWriter) => Promise<T>): Promise<T>
  /** Bloquea el lote de una solicitud del titular y la relee; otra persona recibe `null`. */
  withEntryTransaction<T>(userId: string, entryId: string,
    operate: (state: EntryState, writer: EntryWriter) => Promise<T>): Promise<T>
  /** Lotes con ofertas vencidas o solicitudes de un lote cerrado, vencimiento más antiguo primero. */
  listSettleable(limit: number): Promise<string[]>
  /** Bloquea el lote y registra vencimientos, cierre de la cola y ofertas pendientes. Devuelve las solicitudes cerradas. */
  settleLot(lotId: string): Promise<number>
}
