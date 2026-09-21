// Repositorio en memoria para probar HTTP → Application → Domain sin PostgreSQL.
// Reproduce lo que el adaptador real garantiza: lectura del lote, comprobación
// de pertenencia y escritura condicionada a la versión vigente.

import { randomUUID } from "node:crypto"
import type { Lot, LotStatus } from "../../src/domain/lots.js"
import type { LotRepository, LotWriter, NewLot } from "../../src/application/lots/ports.js"

export interface InMemoryLots extends LotRepository {
  memberships: Set<string>
  lots: Map<string, Lot>
  seedLot(lot: Partial<Lot> & Pick<Lot, "establishmentId" | "declaration">): Lot
}

export function createInMemoryLots(now: () => Date = () => new Date()): InMemoryLots {
  const memberships = new Set<string>()
  const lots = new Map<string, Lot>()

  const isMember = async (userId: string, establishmentId: string): Promise<boolean> =>
    memberships.has(`${userId}:${establishmentId}`)

  const writer: LotWriter = {
    isMemberOfEstablishment: isMember,
    async updateDeclaration(update) {
      const current = lots.get(update.publicId)
      if (current === undefined || current.version !== update.expectedVersion || current.status !== "draft") {
        throw new Error("La actualización del borrador no afectó ninguna fila")
      }
      const updated: Lot = {
        ...current,
        declaration: update.declaration,
        version: current.version + 1,
        updatedAt: update.updatedAt,
      }
      lots.set(updated.publicId, updated)
      return updated
    },
    async markPublished(publication) {
      const current = lots.get(publication.publicId)
      if (current === undefined || current.version !== publication.expectedVersion || current.status !== "draft") {
        throw new Error("La publicación no afectó ninguna fila")
      }
      const published: Lot = {
        ...current,
        status: "published",
        publishedAt: publication.publishedAt,
        updatedAt: publication.publishedAt,
        version: current.version + 1,
      }
      lots.set(published.publicId, published)
      return published
    },
  }

  return {
    memberships,
    lots,

    seedLot(seed) {
      const instant = now()
      const lot: Lot = {
        publicId: seed.publicId ?? randomUUID(),
        establishmentId: seed.establishmentId,
        declaration: seed.declaration,
        status: seed.status ?? "draft",
        version: seed.version ?? 1,
        createdAt: seed.createdAt ?? instant,
        updatedAt: seed.updatedAt ?? instant,
        publishedAt: seed.publishedAt ?? null,
      }
      lots.set(lot.publicId, lot)
      return lot
    },

    isMemberOfEstablishment: isMember,

    async insertLot(lot: NewLot) {
      const instant = now()
      const created: Lot = {
        publicId: randomUUID(),
        establishmentId: lot.establishmentId,
        declaration: lot.declaration,
        status: "draft",
        version: 1,
        createdAt: instant,
        updatedAt: instant,
        publishedAt: null,
      }
      lots.set(created.publicId, created)
      return created
    },

    async findByPublicId(publicId) {
      return lots.get(publicId) ?? null
    },

    async listByEstablishment(establishmentId, statuses?: readonly LotStatus[]) {
      return [...lots.values()]
        .filter((lot) => lot.establishmentId === establishmentId)
        .filter((lot) => statuses === undefined || statuses.includes(lot.status))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    },

    async withLotTransaction(publicId, operate) {
      return operate(lots.get(publicId) ?? null, writer)
    },
  }
}
