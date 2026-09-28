import { lotNotFound, reservationConflict } from '../errors.js'
import type { DiscoveryRepository, SearchFilters } from './ports.js'

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
    async reserve(userId: string, lotId: string, quantity: number, idempotencyKey: string) {
      return repository.withReservationTransaction(userId, lotId, idempotencyKey, async ({ lot, existing, active }, writer) => {
        if (existing) {
          if (existing.lotId !== lotId || existing.quantity !== quantity) throw reservationConflict()
          return { reservation: existing, replay: true }
        }
        if (!lot || lot.pickupEndsAt <= now()) throw lotNotFound()
        if (active || lot.availableQuantity < quantity) throw reservationConflict()
        return { reservation: await writer.insert(quantity, now()), replay: false }
      })
    },
  }
}
