import { lotNotFound, idempotencyConflict, InventoryDiscrepancyError } from '../errors.js'
import type { DiscoveryRepository, SearchFilters } from './ports.js'
import type { Actor } from '../lots/ports.js'
import type { PickupCodes } from '../reservations/ports.js'
import { requireDirectReservation, requireReservationQuantity } from '../../domain/reservations.js'

export function createDiscoveryUseCases(repository: DiscoveryRepository, codes: PickupCodes, now: () => Date) {
  return {
    async search(filters: SearchFilters) {
      const result = await repository.search(filters, now())
      return { ...result, page: filters.page }
    },
    async get(lotId: string) {
      const lot = await repository.get(lotId, now())
      if (!lot) throw lotNotFound()
      return lot
    },
    async reserve(actor: Actor, lotId: string, quantity: number, idempotencyKey: string) {
      requireReservationQuantity(quantity)
      // UUID es insensible a mayúsculas también para el bloqueo y la comparación.
      lotId = lotId.toLowerCase()
      idempotencyKey = idempotencyKey.toLowerCase()
      return repository.withReservationTransaction(actor.userId, lotId, idempotencyKey, async (state, writer) => {
        const { existing } = state
        if (existing) {
          if (existing.lotId !== lotId || existing.quantity !== quantity) throw idempotencyConflict()
          return existing
        }
        if (!state.lot) throw lotNotFound()
        if (!state.reconciled) throw new InventoryDiscrepancyError(lotId)
        // El instante viene de la base después del bloqueo, no del reloj del proceso.
        requireDirectReservation(state.lot, quantity, state.active, state.now)
        // Una reserva confirmada nace con su código de retiro (RF06); cada reserva recibe uno nuevo.
        return writer.insert(quantity, state.now, codes.issue())
      })
    },
  }
}
