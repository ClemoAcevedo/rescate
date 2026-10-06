import { QUANTITY_MAX } from './lots.js'

export class ReservationRuleError extends Error {
  constructor(readonly reason: 'invalid_quantity' | 'unavailable' | 'active_commitment') {
    super(reason)
  }
}

export function requireReservationQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > QUANTITY_MAX) {
    throw new ReservationRuleError('invalid_quantity')
  }
}

/** Reserva directa K015. La disponibilidad se relee después de bloquear el lote. */
export function requireDirectReservation(
  lot: { quantity: number; availableQuantity: number; pickupEndsAt: Date },
  quantity: number, active: boolean, now: Date,
): void {
  requireReservationQuantity(quantity)
  if (active) throw new ReservationRuleError('active_commitment')
  if (lot.pickupEndsAt <= now || quantity > lot.quantity || quantity > lot.availableQuantity) {
    throw new ReservationRuleError('unavailable')
  }
}

export type ReservationStatus = 'confirmed' | 'cancelled' | 'expired' | 'delivered'

/**
 * RF08: una reserva confirmada vence en el instante de cierre del lote, aunque el
 * trabajador todavía no lo haya registrado. Su retraso no prolonga el compromiso.
 */
export function currentStatus(status: ReservationStatus, pickupEndsAt: Date, now: Date): ReservationStatus {
  return status === 'confirmed' && now >= pickupEndsAt ? 'expired' : status
}

/** Instante en que terminó la reserva; el vencimiento ocurre al cierre, no al registrarlo. */
export function endedAt(status: ReservationStatus, stored: Date | null, pickupEndsAt: Date, now: Date): Date | null {
  return currentStatus(status, pickupEndsAt, now) === 'expired' && stored === null ? pickupEndsAt : stored
}

export class ReservationTransitionError extends Error {
  constructor(readonly reason: 'cancelled' | 'expired' | 'delivered' | 'pickup_not_started') {
    super(reason)
  }
}

interface HeldReservation { status: ReservationStatus }
interface PickupWindow { pickupStartsAt: Date; pickupEndsAt: Date }

/**
 * RF05: el titular cancela una reserva confirmada y vigente. Repetir la cancelación
 * no libera otra vez; una reserva retirada o vencida no se cancela.
 */
export function decideCancellation(reservation: HeldReservation, lot: PickupWindow, now: Date): 'cancel' | 'already_cancelled' {
  const status = currentStatus(reservation.status, lot.pickupEndsAt, now)
  if (status === 'cancelled') return 'already_cancelled'
  if (status !== 'confirmed') throw new ReservationTransitionError(status)
  return 'cancel'
}

/**
 * RF06: se retira una reserva confirmada desde el inicio de la ventana y antes de
 * su cierre (anexos H p. 20). Una cancelada, vencida o ya retirada se rechaza.
 */
export function requirePickup(reservation: HeldReservation, lot: PickupWindow, now: Date): void {
  const status = currentStatus(reservation.status, lot.pickupEndsAt, now)
  if (status !== 'confirmed') throw new ReservationTransitionError(status)
  if (now < lot.pickupStartsAt) throw new ReservationTransitionError('pickup_not_started')
}

/** Revisar el código informa si hoy podría confirmarse; no lo reserva ni lo garantiza. */
export function canConfirmPickup(reservation: HeldReservation, lot: PickupWindow, now: Date): boolean {
  return currentStatus(reservation.status, lot.pickupEndsAt, now) === 'confirmed' && now >= lot.pickupStartsAt
}

/**
 * Código de retiro (anexos H p. 21): ocho caracteres de un alfabeto de 32 símbolos.
 * Se usa el alfabeto de Crockford, sin I, L, O ni U, para dictarlo sin ambigüedad.
 */
export const PICKUP_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const PICKUP_CODE_LENGTH = 8

/**
 * Forma canónica del código ingresado por el operador: ignora espacios y guiones,
 * no distingue mayúsculas y lee I/L como 1 y O como 0. `null` si no tiene la forma.
 */
export function normalizePickupCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0')
  if (code.length !== PICKUP_CODE_LENGTH || [...code].some(symbol => !PICKUP_CODE_ALPHABET.includes(symbol))) return null
  return code
}
