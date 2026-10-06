// K022 · Application: límites hacia Infrastructure para cancelar, revisar códigos,
// retirar y vencer reservas. No exponen pg, SQL ni criptografía concreta.
import type { ReservationStatus } from '../../domain/reservations.js'

/** Lote de la reserva tal como lo consulta su titular. */
export interface ReservationLot {
  id: string
  description: string
  conditions: string | null
  address: string
  latitude: number
  longitude: number
  timeZone: string
  pickupStartsAt: Date
  pickupEndsAt: Date
}

/** Reserva con su estado almacenado; Application deriva el vencimiento con su instante. */
export interface StoredReservation {
  id: string
  quantity: number
  status: ReservationStatus
  createdAt: Date
  endedAt: Date | null
  lot: ReservationLot
}

/** Reserva del titular con su código cifrado; `null` si terminó o es anterior a K022. */
export interface HolderReservation extends StoredReservation {
  codeCiphertext: Uint8Array | null
}

/** Código recién emitido: el texto solo se entrega al titular; se guardan cifrado y huella. */
export interface IssuedPickupCode {
  code: string
  ciphertext: Uint8Array
  fingerprint: Uint8Array
}

/** Anexos H p. 21: código aleatorio, cifrado con clave externa y huella para buscarlo. */
export interface PickupCodes {
  issue(): IssuedPickupCode
  reveal(ciphertext: Uint8Array): string
  /** Huella del código ya normalizado; permite buscarlo sin guardarlo legible. */
  fingerprint(code: string): Uint8Array
}

export interface HolderWriter {
  /** RF05: confirmed → cancelled, borra el código cifrado y libera R → F. */
  cancel(at: Date): Promise<void>
  /** Asocia un código a una reserva confirmada que aún no lo tiene (anterior a K022). */
  assignCode(code: IssuedPickupCode): Promise<void>
}

/** Reserva del titular releída bajo bloqueo del lote, con el reloj de la base. */
export type HolderState = { reservation: HolderReservation; now: Date } | null

interface PickupWindow {
  pickupStartsAt: Date
  pickupEndsAt: Date
}

/** Reserva vista por el operador al revisar un código: sin datos del titular. */
export interface ReviewedReservation {
  id: string
  quantity: number
  status: ReservationStatus
  createdAt: Date
  endedAt: Date | null
}

/** Revisión sin bloqueo: permiso sobre el lote y la reserva del lote con esa huella. */
export interface PickupReviewState {
  member: boolean
  lot: PickupWindow
  reservation: ReviewedReservation | null
}

export interface Delivery {
  reservationId: string
  quantity: number
  deliveredAt: Date
}

export interface PickupWriter {
  /** RF06: confirmed → delivered, borra el código cifrado, registra la entrega y mueve R → E. */
  deliver(at: Date): Promise<Delivery>
}

/**
 * Entrega previa de la clave del operador, o el lote releído bajo bloqueo con la
 * reserva indicada solo si corresponde a ese lote y a ese código.
 */
export type PickupState =
  | { existing: Delivery & { lotId: string; codeMatches: boolean }; member: boolean }
  | { existing: null; lot: null }
  | { existing: null; lot: PickupWindow; member: boolean
      reservation: { status: ReservationStatus; quantity: number } | null; now: Date }

export interface ExpiryWriter {
  /** RF08: todas las confirmadas del lote pasan a vencidas y R → X. Devuelve cuántas. */
  expireConfirmed(at: Date): Promise<number>
}

export interface ReservationRepository {
  /** Reservas del titular, creación descendente, páginas de 20. */
  listByHolder(userId: string, page: number): Promise<{ items: StoredReservation[]; hasNextPage: boolean }>
  findByHolder(userId: string, reservationId: string): Promise<HolderReservation | null>
  /** Bloquea el lote de una reserva del titular y la relee; otra persona recibe `null`. */
  withHolderTransaction<T>(userId: string, reservationId: string,
    operate: (state: HolderState, writer: HolderWriter) => Promise<T>): Promise<T>
  /** `null` si el lote no existe. Una huella `null` no corresponde a ninguna reserva. */
  findPickup(userId: string, lotId: string, fingerprint: Uint8Array | null): Promise<PickupReviewState | null>
  /** Serializa la clave por operador, bloquea el lote y relee reserva, permiso y reloj. */
  withPickupTransaction<T>(operatorUserId: string, lotId: string, reservationId: string,
    fingerprint: Uint8Array | null, idempotencyKey: string,
    operate: (state: PickupState, writer: PickupWriter) => Promise<T>): Promise<T>
  /** Lotes cerrados que aún tienen reservas confirmadas, cierre más antiguo primero. */
  listExpirable(limit: number): Promise<string[]>
  /** Bloquea el lote y entrega su cierre con el reloj de la base; `null` si no existe. */
  withExpiryTransaction<T>(lotId: string,
    operate: (state: { pickupEndsAt: Date; now: Date } | null, writer: ExpiryWriter) => Promise<T>): Promise<T>
}
