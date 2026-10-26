// K010 · Application: límites tipados hacia Infrastructure.
// No exponen pg, clientes ni SQL. Se definen junto a su consumidor.

import type { Lot, LotDescription, LotStatus } from "../../domain/lots.js"
import type { PhotoStatus } from "../../domain/photos.js"

/** Actor autenticado. K008 lo resolverá desde la sesión persistida. */
export interface Actor {
  /** ID interno obtenido de la sesión por K008, no del cuerpo HTTP. */
  userId: string
}

export interface NewLot {
  establishmentId: string
  description: LotDescription
}

export interface LotUpdate {
  publicId: string
  description: LotDescription
  /** Versión leída por el operador: protege la edición concurrente. */
  expectedVersion: number
  updatedAt: Date
}

export interface LotPublication {
  publicId: string
  expectedVersion: number
  publishedAt: Date
}

/** Resumen de un lote para el listado de su establecimiento. */
export interface LotSummary {
  publicId: string
  status: LotStatus
  version: number
  description: string
  category: string
  quantity: number
  reservedQuantity: number
  pickupStartsAt: Date
  pickupEndsAt: Date
  timeZone: string
  createdAt: Date
  publishedAt: Date | null
  /** Primera foto lista por posición. */
  photoId: string | null
}

export interface LotListFilter {
  status?: LotStatus
  page: number
}

/**
 * Persistencia de lotes y de la pertenencia necesaria para autorizarlos.
 * Las operaciones que leen y escriben el mismo lote se ejecutan dentro de
 * `withLotTransaction`, que Infrastructure resuelve con un único cliente.
 */
export interface LotRepository {
  findEstablishment(publicId: string): Promise<{ id: string; publicId: string } | null>
  isMemberOfEstablishment(userId: string, establishmentId: string): Promise<boolean>
  insertLot(lot: NewLot): Promise<Lot>
  findByPublicId(publicId: string): Promise<Lot | null>
  /** Lotes del establecimiento (ID interno), publicación o creación descendente, páginas de 20. */
  listByEstablishment(establishmentId: string, filter: LotListFilter): Promise<{ items: LotSummary[]; hasNextPage: boolean }>
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
  updateDescription(update: LotUpdate): Promise<Lot>
  markPublished(publication: LotPublication): Promise<Lot>
  /** Estados de las fotos activas del lote bloqueado: en carga vigente, validación, listas o rechazadas. */
  listPhotoStatuses(lotPublicId: string, now: Date): Promise<PhotoStatus[]>
}

/** Instante de la operación. Se inyecta para poder fijarlo en las pruebas. */
export type Clock = () => Date
