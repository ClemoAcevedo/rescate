// K027 · Application: ingreso, salida, oferta y aceptación de la cola FIFO (RF07).
// Coordina autorización, reglas de Domain y atomicidad; el lote se bloquea en cada comando.
import { idempotencyConflict, InventoryDiscrepancyError, lotNotFound, waitlistEntryNotFound } from '../errors.js'
import type { Actor } from '../lots/ports.js'
import type { PickupCodes } from '../reservations/ports.js'
import type { StoredWaitlistEntry, WaitlistRepository } from './ports.js'
import {
  currentWaitlistStatus, decideAcceptance, decideDecline, decideLeave, requireWaitlistEntry,
  waitlistEndedAt, WaitlistTransitionError,
} from '../../domain/waitlist.js'
import type { WaitlistDecision } from '../../domain/waitlist.js'

/** Estado vigente: una oferta vencida o una cola de un lote cerrado se muestran terminadas aunque no estén registradas. */
function present(entry: StoredWaitlistEntry, at: Date): StoredWaitlistEntry {
  const status = currentWaitlistStatus(entry, entry.lot, at)
  return { ...entry, status, endedAt: waitlistEndedAt(entry, entry.lot, at),
    position: status === 'waiting' ? entry.position : null }
}

type Outcome = { entry: StoredWaitlistEntry } | { rejected: WaitlistTransitionError['reason'] } | { missing: true }

export function createWaitlistUseCases(repository: WaitlistRepository, codes: PickupCodes, now: () => Date) {
  const lower = (value: string) => value.toLowerCase()

  /** Los rechazos se devuelven en vez de lanzarse dentro de la transacción: así se conservan los vencimientos que registró. */
  function settled(outcome: Outcome): StoredWaitlistEntry {
    if ('missing' in outcome) throw waitlistEntryNotFound()
    if ('rejected' in outcome) throw new WaitlistTransitionError(outcome.rejected)
    return outcome.entry
  }
  const decide = <R extends string>(decision: WaitlistDecision<R>, entry: StoredWaitlistEntry, at: Date): Outcome | null => {
    if (decision.kind === 'reject') return { rejected: decision.reason }
    return decision.kind === 'replay' ? { entry: present(entry, at) } : null
  }

  return {
    async list(actor: Actor, page: number) {
      const at = now()
      const result = await repository.listByHolder(actor.userId, page)
      return { items: result.items.map(entry => present(entry, at)), hasNextPage: result.hasNextPage, page }
    },

    async get(actor: Actor, entryId: string) {
      const found = await repository.findByHolder(actor.userId, lower(entryId))
      if (!found) throw waitlistEntryNotFound()
      return present(found, now())
    },

    /**
     * RF07: entra al final de la cola cuando la cantidad no se puede reservar directamente.
     * La misma clave devuelve la solicitud existente, aunque ya haya avanzado de estado.
     */
    async join(actor: Actor, lotId: string, quantity: number, idempotencyKey: string) {
      lotId = lower(lotId)
      return repository.withJoinTransaction(actor.userId, lotId, lower(idempotencyKey), async (state, writer) => {
        if (state.existing) {
          const { lotId: existingLot, ...entry } = state.existing
          if (existingLot !== lotId || entry.requestedQuantity !== quantity) throw idempotencyConflict()
          return present(entry, now())
        }
        if (!state.lot) throw lotNotFound()
        if (!state.reconciled) throw new InventoryDiscrepancyError(lotId)
        requireWaitlistEntry(state.lot, quantity, state.active, state.queued, state.now)
        return present(await writer.enqueue(quantity, state.now), state.now)
      })
    },

    /**
     * Aceptar una oferta vigente confirma solo la cantidad ofrecida (O → R), cierra la
     * solicitud sin saldo prioritario y emite el código de la nueva reserva. Repetirlo
     * devuelve la misma reserva; una oferta vencida ya no se acepta.
     */
    async accept(actor: Actor, entryId: string) {
      return settled(await repository.withEntryTransaction(actor.userId, lower(entryId), async (state, writer): Promise<Outcome> => {
        if (!state) return { missing: true }
        const { entry, now: at } = state
        const early = decide(decideAcceptance(currentWaitlistStatus(entry, entry.lot, at)), entry, at)
        if (early) return early
        const reservationId = await writer.accept(codes.issue(), at)
        return { entry: present({ ...entry, status: 'accepted', reservationId, endedAt: at, position: null }, at) }
      }))
    },

    /** Rechazar cierra la solicitud, libera lo retenido y no crea reingreso: volver exige una solicitud nueva. */
    async decline(actor: Actor, entryId: string) {
      return settled(await repository.withEntryTransaction(actor.userId, lower(entryId), async (state, writer): Promise<Outcome> => {
        if (!state) return { missing: true }
        const { entry, now: at } = state
        const early = decide(decideDecline(currentWaitlistStatus(entry, entry.lot, at)), entry, at)
        if (early) return early
        await writer.decline(at)
        return { entry: present({ ...entry, status: 'declined', endedAt: at, position: null }, at) }
      }))
    },

    /** Salir solo corresponde a quien espera sin oferta; la posición se pierde y volver exige una solicitud nueva. */
    async leave(actor: Actor, entryId: string) {
      return settled(await repository.withEntryTransaction(actor.userId, lower(entryId), async (state, writer): Promise<Outcome> => {
        if (!state) return { missing: true }
        const { entry, now: at } = state
        const early = decide(decideLeave(currentWaitlistStatus(entry, entry.lot, at)), entry, at)
        if (early) return early
        await writer.leave(at)
        return { entry: present({ ...entry, status: 'left', endedAt: at, position: null }, at) }
      }))
    },

    /** RF08: registra ofertas vencidas y colas de lotes cerrados, y ofrece lo liberado a quien sigue. */
    async settleLot(lotId: string): Promise<number> {
      return repository.settleLot(lower(lotId))
    },

    /** Lote de trabajo para el trabajador de vencimientos (K028). Devuelve solicitudes cerradas. */
    async settleDue(limit = 50): Promise<number> {
      let closed = 0
      for (const lotId of await repository.listSettleable(limit)) closed += await repository.settleLot(lotId)
      return closed
    },
  }
}

export type WaitlistUseCases = ReturnType<typeof createWaitlistUseCases>
