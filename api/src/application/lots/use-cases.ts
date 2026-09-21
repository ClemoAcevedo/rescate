// K010 · Application: casos de uso de borrador y publicación de lotes (RF02).
// Coordinan autorización, reglas de Domain y atomicidad. No conocen Express,
// pg, cookies ni códigos HTTP.

import { declareDraftEdit, declareLot, publishLot as applyPublication } from "../../domain/lots.js"
import type { Lot, LotDeclaration } from "../../domain/lots.js"
import { establishmentNotFound, lotNotFound, notAuthorized, versionConflict } from "../errors.js"
import type { Actor, Clock, LotRepository, LotWriter } from "./ports.js"

export interface LotUseCases {
  createDraft(actor: Actor, input: CreateDraftInput): Promise<Lot>
  updateDraft(actor: Actor, input: UpdateDraftInput): Promise<Lot>
  publish(actor: Actor, input: PublishInput): Promise<Lot>
  getLot(actor: Actor, publicId: string): Promise<Lot>
}

export interface CreateDraftInput {
  /** ID público recibido por HTTP; se resuelve antes de autorizar. */
  establishmentId: string
  declaration: LotDeclaration
}

export interface UpdateDraftInput {
  publicId: string
  declaration: Partial<LotDeclaration>
  expectedVersion: number
}

export interface PublishInput {
  publicId: string
  expectedVersion: number
}

/**
 * Un operador solo actúa sobre lotes de un establecimiento al que pertenece.
 * Comprobar pertenencia es responsabilidad del caso de uso: un filtro SQL o una
 * vista oculta no sustituyen esta decisión.
 */
async function requireMembership(
  source: Pick<LotRepository, "isMemberOfEstablishment">,
  actor: Actor,
  establishmentId: string,
): Promise<void> {
  if (!(await source.isMemberOfEstablishment(actor.userId, establishmentId))) throw notAuthorized()
}

/**
 * La versión leída por el operador debe seguir vigente. Evita que dos ediciones
 * simultáneas del mismo borrador se pisen sin aviso (anexos C p. 5).
 */
function requireVersion(lot: Lot, expectedVersion: number): void {
  if (lot.version !== expectedVersion) throw versionConflict()
}

export function createLotUseCases(repository: LotRepository, now: Clock): LotUseCases {
  return {
    async createDraft(actor, input) {
      const establishment = await repository.findEstablishment(input.establishmentId)
      if (establishment === null) throw establishmentNotFound()
      await requireMembership(repository, actor, establishment.id)
      // Domain valida antes de escribir: un borrador inválido no se persiste.
      const declaration = declareLot(input.declaration)
      return repository.insertLot({ establishmentId: establishment.id, declaration })
    },

    async updateDraft(actor, input) {
      return repository.withLotTransaction(input.publicId, async (lot, writer) => {
        const target = await authorizeLot(lot, actor, writer)
        requireVersion(target, input.expectedVersion)
        // Rechaza editar un lote publicado y valida la nueva declaración.
        const declaration = declareDraftEdit(target, { ...target.declaration, ...input.declaration })
        return writer.updateDeclaration({
          publicId: target.publicId,
          declaration,
          expectedVersion: input.expectedVersion,
          updatedAt: now(),
        })
      })
    },

    async publish(actor, input) {
      return repository.withLotTransaction(input.publicId, async (lot, writer) => {
        const target = await authorizeLot(lot, actor, writer)
        requireVersion(target, input.expectedVersion)
        // El instante se lee después de obtener el lote bloqueado.
        const published = applyPublication(target, now())
        return writer.markPublished({
          publicId: target.publicId,
          expectedVersion: input.expectedVersion,
          publishedAt: published.publishedAt as Date,
        })
      })
    },

    async getLot(actor, publicId) {
      const lot = await repository.findByPublicId(publicId)
      return authorizeLot(lot, actor, repository)
    },
  }
}

/**
 * Un lote inexistente y uno de otro establecimiento se distinguen dentro del
 * caso de uso; HTTP decide qué revelar para no confirmar existencia ajena.
 */
async function authorizeLot(
  lot: Lot | null,
  actor: Actor,
  source: Pick<LotRepository | LotWriter, "isMemberOfEstablishment">,
): Promise<Lot> {
  if (lot === null) throw lotNotFound()
  await requireMembership(source, actor, lot.establishmentId)
  return lot
}
