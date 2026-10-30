// K027 · Domain: cola FIFO y ofertas (RF07, ADR 0002). Reglas puras: el instante
// llega siempre de quien bloqueó el lote y los plazos no dependen del reloj del proceso.
import { requireReservationQuantity, ReservationRuleError } from './reservations.js'

/** Anexos H p. 20: una oferta dura diez minutos o hasta el cierre, lo que ocurra primero. */
export const OFFER_DURATION_MS = 10 * 60_000
/** Anexos H p. 20: con menos de un minuto de ventana no se ofrece. */
export const OFFER_MIN_REMAINING_MS = 60_000

export type WaitlistStatus = 'waiting' | 'offered' | 'accepted' | 'declined' | 'expired' | 'left'

export class WaitlistTransitionError extends Error {
  constructor(readonly reason: 'not_offered' | 'not_waiting' | 'accepted' | 'declined' | 'expired' | 'left') {
    super(reason)
  }
}

interface LotWindow { pickupEndsAt: Date }

/** Un lote cerrado o retirado ya no asigna: lo retenido y lo que espera termina sin volver a ofrecerse. */
export function isAssignable(lot: LotWindow & { status: string }, now: Date): boolean {
  return lot.status === 'published' && now < lot.pickupEndsAt
}

/**
 * RF07: se entra a la espera cuando la cantidad no se puede reservar directamente. Con
 * personas esperando, nadie adelanta (anexos B p. 4); con libres suficientes y la cola
 * vacía, la reserva directa es el camino y no se abre una solicitud.
 */
export function requireWaitlistEntry(
  lot: { quantity: number; availableQuantity: number; pickupEndsAt: Date },
  quantity: number, active: boolean, queued: boolean, now: Date,
): void {
  requireReservationQuantity(quantity)
  if (active) throw new ReservationRuleError('active_commitment')
  if (lot.pickupEndsAt <= now || quantity > lot.quantity) throw new ReservationRuleError('unavailable')
  if (!queued && quantity <= lot.availableQuantity) throw new ReservationRuleError('directly_available')
}

/** Vigencia de una oferta emitida en `now`, o `null` si queda menos de un minuto de ventana. */
export function offerExpiry(now: Date, pickupEndsAt: Date): Date | null {
  if (pickupEndsAt.getTime() - now.getTime() < OFFER_MIN_REMAINING_MS) return null
  return new Date(Math.min(now.getTime() + OFFER_DURATION_MS, pickupEndsAt.getTime()))
}

export interface QueuedRequest { id: string; requestedQuantity: number }
export interface PlannedOffer { id: string; quantity: number; expiresAt: Date }

/**
 * ADR 0002: los libres se ofrecen en orden FIFO. Cada solicitud recibe lo que pidió o,
 * si no alcanza, todo lo que queda (oferta parcial); nadie posterior la adelanta, y
 * mientras queden libres se sigue con la siguiente. La cola nunca se reordena.
 */
export function planOffers(free: number, waiting: readonly QueuedRequest[], now: Date, pickupEndsAt: Date): PlannedOffer[] {
  const expiresAt = offerExpiry(now, pickupEndsAt)
  const plan: PlannedOffer[] = []
  if (expiresAt === null) return plan
  let remaining = free
  for (const request of waiting) {
    if (remaining <= 0) break
    // Cada oferta queda acotada por los packs todavía libres.
    const quantity = Math.min(request.requestedQuantity, remaining)
    plan.push({ id: request.id, quantity, expiresAt })
    remaining -= quantity
  }
  return plan
}

interface EntryState {
  status: WaitlistStatus
  offerExpiresAt: Date | null
}

/**
 * Estado vigente: una oferta no aceptada a tiempo vence aunque nadie la haya registrado
 * (RF08), y una solicitud sin oferta vence al cierre del lote. El retraso del trabajador
 * no prolonga ninguna de las dos.
 */
export function currentWaitlistStatus(entry: EntryState, lot: LotWindow, now: Date): WaitlistStatus {
  if (entry.status === 'offered' && entry.offerExpiresAt !== null && now >= entry.offerExpiresAt) return 'expired'
  if ((entry.status === 'waiting' || entry.status === 'offered') && now >= lot.pickupEndsAt) return 'expired'
  return entry.status
}

/** Instante en que terminó la solicitud: el fin de la oferta o el cierre, no cuando se registra. */
export function waitlistEndedAt(entry: EntryState & { endedAt: Date | null }, lot: LotWindow, now: Date): Date | null {
  if (entry.endedAt !== null) return entry.endedAt
  if (currentWaitlistStatus(entry, lot, now) !== 'expired') return null
  return entry.status === 'offered' && entry.offerExpiresAt !== null && entry.offerExpiresAt < lot.pickupEndsAt
    ? entry.offerExpiresAt : lot.pickupEndsAt
}

export type WaitlistDecision<Replay extends string = never> =
  | { kind: 'apply' }
  | { kind: 'replay'; status: Replay }
  | { kind: 'reject'; reason: WaitlistTransitionError['reason'] }

/** Aceptar exige una oferta vigente. Repetir una aceptación ya hecha devuelve la misma reserva. */
export function decideAcceptance(status: WaitlistStatus): WaitlistDecision<'accepted'> {
  if (status === 'offered') return { kind: 'apply' }
  if (status === 'accepted') return { kind: 'replay', status }
  return { kind: 'reject', reason: status === 'waiting' ? 'not_offered' : status }
}

/** Rechazar exige una oferta vigente; repetirlo no libera otra vez. */
export function decideDecline(status: WaitlistStatus): WaitlistDecision<'declined'> {
  if (status === 'offered') return { kind: 'apply' }
  if (status === 'declined') return { kind: 'replay', status }
  return { kind: 'reject', reason: status === 'waiting' ? 'not_offered' : status }
}

/** Salir de la cola solo corresponde a quien aún espera; con una oferta se rechaza. */
export function decideLeave(status: WaitlistStatus): WaitlistDecision<'left'> {
  if (status === 'waiting') return { kind: 'apply' }
  if (status === 'left') return { kind: 'replay', status }
  return { kind: 'reject', reason: status === 'offered' ? 'not_waiting' : status }
}
