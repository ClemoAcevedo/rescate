import { lotNotFound, idempotencyConflict } from '../errors.js'
import type { DiscoveryRepository, SearchFilters } from './ports.js'
import type { Actor } from '../lots/ports.js'
import { requireDirectReservation, requireReservationQuantity } from '../../domain/reservations.js'

export function createDiscoveryUseCases(repository: DiscoveryRepository, now: () => Date) {
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
      return repository.withReservationTransaction(actor.userId, lotId, idempotencyKey, async ({ lot, existing, active }, writer) => {
        if (existing) {
          if (existing.lotId !== lotId || existing.quantity !== quantity) throw idempotencyConflict()
          return existing
        }
        if (!lot) throw lotNotFound()
        const at = now()
        requireDirectReservation(lot, quantity, active, at)
        return writer.insert(quantity, at)
      })
    },
  }
}
