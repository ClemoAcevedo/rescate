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
