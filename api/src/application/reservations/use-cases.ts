// K022 · Application: consulta del titular, cancelación (RF05), revisión y retiro
// (RF06) y vencimiento (RF08). Coordina autorización, reglas de Domain y atomicidad.
import { idempotencyConflict, lotNotFound, notAuthorized, pickupCodeNotFound, reservationNotFound } from '../errors.js'
import type { Actor } from '../lots/ports.js'
import type { PickupCodes, ReservationRepository, ReviewedReservation, StoredReservation } from './ports.js'
import {
  canConfirmPickup, currentStatus, decideCancellation, endedAt, normalizePickupCode, requirePickup,
} from '../../domain/reservations.js'

/** Estado vigente: una confirmada cuyo lote cerró se muestra vencida aunque no esté registrada. */
function present<R extends Omit<StoredReservation, 'lot'>>(reservation: R, window: { pickupEndsAt: Date }, at: Date) {
  return { ...reservation,
    status: currentStatus(reservation.status, window.pickupEndsAt, at),
    endedAt: endedAt(reservation.status, reservation.endedAt, window.pickupEndsAt, at) }
}
/** Vista del titular: nunca incluye el código cifrado. */
function forHolder(reservation: StoredReservation & { codeCiphertext?: unknown }, at: Date) {
  const { codeCiphertext: _hidden, ...visible } = reservation
  return present(visible, visible.lot, at)
}

export function createReservationUseCases(repository: ReservationRepository, codes: PickupCodes, now: () => Date) {
  const lower = (value: string) => value.toLowerCase()

  /**
   * RF08: registra el vencimiento de las reservas confirmadas de un lote cerrado.
   * Termina al cierre, no cuando se procesa; repetirlo no libera nuevamente.
   */
  async function expireLot(lotId: string): Promise<number> {
    return repository.withExpiryTransaction(lower(lotId), async (state, writer) => {
      if (!state || state.now < state.pickupEndsAt) return 0
      return writer.expireConfirmed(state.pickupEndsAt)
    })
  }

  return {
    async list(actor: Actor, page: number) {
      const at = now()
      const result = await repository.listByHolder(actor.userId, page)
      return { items: result.items.map(reservation => forHolder(reservation, at)), hasNextPage: result.hasNextPage, page }
    },

    /** RF06: el titular consulta su código solo mientras la reserva sigue confirmada. */
    async get(actor: Actor, reservationId: string) {
      const id = lower(reservationId)
      const found = await repository.findByHolder(actor.userId, id)
      if (!found) throw reservationNotFound()
      const view = forHolder(found, now())
      if (view.status !== 'confirmed') return { ...view, pickupCode: null }
      if (found.codeCiphertext) return { ...view, pickupCode: codes.reveal(found.codeCiphertext) }
      // Reservas confirmadas antes de K022: el código se emite una sola vez, bajo bloqueo del lote.
      return repository.withHolderTransaction(actor.userId, id, async (state, writer) => {
        if (!state) throw reservationNotFound()
        const current = forHolder(state.reservation, state.now)
        if (current.status !== 'confirmed') return { ...current, pickupCode: null }
        if (state.reservation.codeCiphertext) return { ...current, pickupCode: codes.reveal(state.reservation.codeCiphertext) }
        const issued = codes.issue()
        await writer.assignCode(issued)
        return { ...current, pickupCode: issued.code }
      })
    },

    /**
     * RF05: solo el titular cancela una reserva confirmada y vigente. La misma
     * transacción invalida el código y libera la cantidad; repetir no libera otra vez.
     */
    async cancel(actor: Actor, reservationId: string) {
      return repository.withHolderTransaction(actor.userId, lower(reservationId), async (state, writer) => {
        if (!state) throw reservationNotFound()
        const { reservation, now: at } = state
        if (decideCancellation(reservation, reservation.lot, at) === 'already_cancelled') {
          return { ...forHolder(reservation, at), pickupCode: null }
        }
        await writer.cancel(at)
        return { ...forHolder({ ...reservation, status: 'cancelled', endedAt: at }, at), pickupCode: null }
      })
    },

    /**
     * Revisar muestra la reserva del código sin consumirlo ni garantizar el retiro.
     * Un código inexistente, mal formado o de otro lote responde igual.
     */
    async reviewPickup(actor: Actor, lotId: string, code: string) {
      const normalized = normalizePickupCode(code)
      const found = await repository.findPickup(actor.userId, lower(lotId),
        normalized === null ? null : codes.fingerprint(normalized))
      if (!found) throw lotNotFound()
      if (!found.member) throw notAuthorized()
      if (!found.reservation) throw pickupCodeNotFound()
      const at = now()
      return { reservation: present<ReviewedReservation>(found.reservation, found.lot, at),
        canConfirm: canConfirmPickup(found.reservation, found.lot, at) }
    },

    /**
     * RF06: confirmar vuelve a validar lote, permiso, reserva, código y ventana bajo
     * bloqueo, aunque la revisión previa haya sido válida. La clave del operador
     * reproduce la entrega original; otro intento informa que ya se retiró.
     */
    async confirmPickup(actor: Actor, lotId: string, reservationId: string, code: string, idempotencyKey: string) {
      const lot = lower(lotId); const reservation = lower(reservationId)
      const normalized = normalizePickupCode(code)
      const fingerprint = normalized === null ? null : codes.fingerprint(normalized)
      return repository.withPickupTransaction(actor.userId, lot, reservation, fingerprint, lower(idempotencyKey),
        async (state, writer) => {
          if (state.existing) {
            if (!state.member) throw notAuthorized()
            const { lotId: deliveredLot, codeMatches, ...delivery } = state.existing
            if (deliveredLot !== lot || delivery.reservationId !== reservation || !codeMatches) throw idempotencyConflict()
            return delivery
          }
          if (!state.lot) throw lotNotFound()
          if (!state.member) throw notAuthorized()
          if (!state.reservation) throw pickupCodeNotFound()
          requirePickup(state.reservation, state.lot, state.now)
          return writer.deliver(state.now)
        })
    },

    expireLot,

    /** Lote de trabajo para el trabajador de vencimientos (K028). Devuelve reservas vencidas. */
    async expireDue(limit = 50): Promise<number> {
      let expired = 0
      for (const lotId of await repository.listExpirable(limit)) expired += await expireLot(lotId)
      return expired
    },
  }
}

export type ReservationUseCases = ReturnType<typeof createReservationUseCases>
