// K010 · Application: límites tipados hacia Infrastructure.
// No exponen pg, clientes ni SQL. Se definen junto a su consumidor.

import type { Lot, LotDeclaration, LotStatus } from "../../domain/lots.js"

/** Actor autenticado. K008 lo resolverá desde la sesión persistida. */
export interface Actor {
  userId: string
}

export interface NewLot {
  establishmentId: string
  declaration: LotDeclaration
}

export interface LotUpdate {
  publicId: string
  declaration: LotDeclaration
  /** Versión leída por el operador: protege la edición concurrente. */
  expectedVersion: number
  updatedAt: Date
}

export interface LotPublication {
  publicId: string
  expectedVersion: number
  publishedAt: Date
}

/**
 * Persistencia de lotes y de la pertenencia necesaria para autorizarlos.
 * Las operaciones que leen y escriben el mismo lote se ejecutan dentro de
 * `withLotTransaction`, que Infrastructure resuelve con un único cliente.
 */
export interface LotRepository {
  isMemberOfEstablishment(userId: string, establishmentId: string): Promise<boolean>
  insertLot(lot: NewLot): Promise<Lot>
  findByPublicId(publicId: string): Promise<Lot | null>
  listByEstablishment(establishmentId: string, statuses?: readonly LotStatus[]): Promise<Lot[]>
  /**
   * Bloquea el lote, entrega el estado releído y confirma los cambios juntos.
   * Devolver `null` desde `operate` deja la transacción sin escrituras.
   */
  withLotTransaction<T>(
    publicId: string,
    operate: (lot: Lot | null, writer: LotWriter) => Promise<T>,
  ): Promise<T>
}

/** Escrituras disponibles dentro de una transacción ya iniciada. */
export interface LotWriter {
  isMemberOfEstablishment(userId: string, establishmentId: string): Promise<boolean>
  updateDeclaration(update: LotUpdate): Promise<Lot>
  markPublished(publication: LotPublication): Promise<Lot>
}

/** Instante de la operación. Se inyecta para poder fijarlo en las pruebas. */
export type Clock = () => Date
