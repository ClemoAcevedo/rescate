// K022 · Application: consulta del titular, cancelación (RF05), revisión y retiro
// (RF06). Coordina autorización, reglas de Domain y atomicidad. El vencimiento (RF08)
// se decide aquí con el cierre del lote y se registra en expiries/ (K028).
import {
  PickupReviewSuspendedError, idempotencyConflict, lotNotFound, notAuthorized, pickupCodeNotFound, reservationNotFound,
} from '../errors.js'
import type { Actor } from '../lots/ports.js'
import type {
  AdmitCodeAttempt, PickupAttemptSteps, PickupAttempts, PickupCodes, ReservationRepository, ReviewedReservation,
  StoredReservation,
} from './ports.js'
import {
  canConfirmPickup, currentStatus, decideCancellation, endedAt, normalizePickupCode, requirePickup,
} from '../../domain/reservations.js'
import { blockAfterFailure, expiredFailuresCutoff, retryAfterSeconds } from '../../domain/attempts.js'

/** Estado vigente: una confirmada cuyo lote cerró se muestra vencida aunque no esté registrada. */
function present<R extends Omit<StoredReservation, 'lot'>>(reservation: R, window: { pickupEndsAt: Date }, at: Date) {
  return { ...reservation,
    status: currentStatus(reservation.status, window.pickupEndsAt, at),
    endedAt: endedAt(reservation.status, reservation.endedAt, window.pickupEndsAt, at) }
}
/**
 * K034 (anexos H p. 21): mientras dure la suspensión no se busca ningún código, así que
 * un código correcto tampoco responde y el límite no sirve de oráculo.
 */
function requireCodeAttempt(attempts: PickupAttempts): void {
  const retryAfter = retryAfterSeconds(attempts.blockedUntil, attempts.now)
  if (retryAfter > 0) throw new PickupReviewSuspendedError(retryAfter)
}

/** Un código que no corresponde a una reserva del lote cuenta como fallo; el quinto en la ventana suspende. */
async function recordCodeFailure({ failureTimes, now }: PickupAttempts, steps: PickupAttemptSteps): Promise<void> {
  const until = blockAfterFailure(failureTimes, now)
  await steps.deleteFailuresThrough(expiredFailuresCutoff(now))
  await steps.recordFailure(now)
  await steps.setBlockedUntil(until)
}

/** Vista del titular: nunca incluye el código cifrado. */
function forHolder(reservation: StoredReservation & { codeCiphertext?: unknown }, at: Date) {
  const { codeCiphertext: _hidden, ...visible } = reservation
  return present(visible, visible.lot, at)
}

export function createReservationUseCases(repository: ReservationRepository, codes: PickupCodes, now: () => Date) {
  const lower = (value: string) => value.toLowerCase()

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
     * Un código inexistente, mal formado o de otro lote responde igual y cuenta como
     * fallo del operador; el fallo se confirma antes de responder.
     */
    async reviewPickup(actor: Actor, lotId: string, code: string, admit: AdmitCodeAttempt) {
      const normalized = normalizePickupCode(code)
      const fingerprint = normalized === null ? null : codes.fingerprint(normalized)
      const found = await repository.withPickupAttempts(actor.userId, async (attempts, steps) => {
        requireCodeAttempt(attempts)
        const reviewed = await steps.review(lower(lotId), fingerprint)
        if (!reviewed) throw lotNotFound()
        if (!reviewed.member) throw notAuthorized()
        admit()
        if (reviewed.reservation) return { lot: reviewed.lot, reservation: reviewed.reservation }
        await recordCodeFailure(attempts, steps)
        return null
      })
      if (!found) throw pickupCodeNotFound()
      const at = now()
      return { reservation: present<ReviewedReservation>(found.reservation, found.lot, at),
        canConfirm: canConfirmPickup(found.reservation, found.lot, at) }
    },

    /**
     * RF06: confirmar vuelve a validar lote, permiso, reserva, código y ventana bajo
     * bloqueo, aunque la revisión previa haya sido válida. La clave del operador
     * reproduce la entrega original; otro intento informa que ya se retiró. Un código
     * que no corresponde a esa reserva del lote cuenta como fallo, igual que al revisar.
     */
    async confirmPickup(actor: Actor, lotId: string, reservationId: string, code: string, idempotencyKey: string,
      admit: AdmitCodeAttempt) {
      const lot = lower(lotId); const reservation = lower(reservationId)
      const normalized = normalizePickupCode(code)
      const fingerprint = normalized === null ? null : codes.fingerprint(normalized)
      const delivery = await repository.withPickupAttempts(actor.userId, async (attempts, steps) => {
        requireCodeAttempt(attempts)
        return steps.confirm(lot, reservation, fingerprint, lower(idempotencyKey), async (state, writer) => {
          if (state.existing) {
            if (!state.member) throw notAuthorized()
            const { lotId: deliveredLot, codeMatches, ...delivery } = state.existing
            if (deliveredLot !== lot || delivery.reservationId !== reservation) throw idempotencyConflict()
            // Solo aquí se compara el código, contra la reserva ya retirada con esta clave.
            admit()
            if (!codeMatches) throw idempotencyConflict()
            return delivery
          }
          if (!state.lot) throw lotNotFound()
          if (!state.member) throw notAuthorized()
          admit()
          if (!state.reservation) {
            await recordCodeFailure(attempts, steps)
            return null
          }
          requirePickup(state.reservation, state.lot, state.now)
          return writer.deliver(state.now)
        })
      })
      if (!delivery) throw pickupCodeNotFound()
      return delivery
    },
  }
}

export type ReservationUseCases = ReturnType<typeof createReservationUseCases>
