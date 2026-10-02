// K014 · Application: límites hacia persistencia, objetos e imágenes. No exponen
// pg, SDK S3, rutas de disco ni la librería de imágenes.

import type { LotStatus } from "../../domain/lots.js"
import type { ImageFormat, PhotoRejection, PhotoStatus, Rendition, RenditionLimits, SourceImage } from "../../domain/photos.js"

export interface LotPhoto {
  publicId: string
  position: number
  status: PhotoStatus
  uploadedBy: string
  createdAt: Date
  uploadExpiresAt: Date
  format: ImageFormat | null
  width: number | null
  height: number | null
  rejectionReason: PhotoRejection | null
}

/** Lo necesario del lote para autorizar: nunca se expone su PK por HTTP. */
export interface PhotoLot {
  publicId: string
  establishmentId: string
  status: LotStatus
}

export interface NewUpload {
  uploadedBy: string
  position: number
  createdAt: Date
  expiresAt: Date
}

export interface ProcessingResult {
  status: "ready" | "rejected"
  format?: ImageFormat
  width?: number
  height?: number
  rejectionReason?: PhotoRejection
}

/** Foto reclamada por un worker hasta `claimedUntil`. */
export interface PhotoClaim {
  publicId: string
  attempts: number
  sourceBytes: number
}

export type CleanupKind = "expired_upload" | "removed" | "processed"
export interface CleanupItem { publicId: string; kind: CleanupKind }

/**
 * Persistencia de fotos. `withLotPhotos` bloquea el lote con un único cliente:
 * serializa cargas, retiros y publicación del mismo lote.
 */
export interface PhotoRepository {
  withLotPhotos<T>(lotPublicId: string, operate: (lot: PhotoLot | null, writer: PhotoWriter) => Promise<T>): Promise<T>
  /** Lectura sin bloqueo para consultar o servir fotos. */
  findLotPhotos(lotPublicId: string): Promise<{ lot: PhotoLot; photos: LotPhoto[] } | null>
  isMemberOfEstablishment(userId: string, establishmentId: string): Promise<boolean>
  /** Reclama la foto pendiente más antigua sin vencer su reclamo y confirma el reclamo. */
  claimNextPending(now: Date, claimedUntil: Date): Promise<PhotoClaim | null>
  /** Registra el resultado si la foto sigue pendiente; false si fue quitada entretanto. */
  finishProcessing(photoId: string, result: ProcessingResult, at: Date): Promise<boolean>
  markUploadDeleted(photoId: string, at: Date): Promise<void>
  markObjectsDeleted(photoId: string, at: Date): Promise<void>
  /** Marca quitada una carga vencida que nadie confirmó. */
  expireUpload(photoId: string, before: Date, at: Date): Promise<boolean>
  listCleanup(expiredBefore: Date, limit: number): Promise<CleanupItem[]>
}

/** Escrituras dentro de la transacción que bloquea el lote. */
export interface PhotoWriter {
  isMemberOfEstablishment(userId: string, establishmentId: string): Promise<boolean>
  /** Fotos no quitadas del lote; las cargas vencidas pasan antes a quitadas. */
  listActivePhotos(now: Date): Promise<LotPhoto[]>
  /** Serializa por operador y cuenta sus cargas vigentes en cualquier lote. */
  activeUploadsOf(userId: string, now: Date): Promise<Date[]>
  insertUpload(upload: NewUpload): Promise<LotPhoto>
  /** Cambia una carga vigente a pendiente; false si venció o fue quitada. */
  confirmUpload(photoId: string, sourceBytes: number, now: Date): Promise<LotPhoto | null>
  removePhoto(photoId: string, at: Date): Promise<boolean>
}

/** Almacenamiento privado de objetos. Borrar una clave inexistente no es error. */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  /** Null si el objeto no existe. */
  get(key: string): Promise<Uint8Array | null>
  remove(key: string): Promise<void>
}

export interface ImageProcessor {
  /** Metadatos sin transformar; null si no se puede decodificar. */
  inspect(bytes: Uint8Array): Promise<SourceImage | null>
  /** WebP orientado, sin metadatos y dentro de los límites si es posible; null si falla. */
  render(bytes: Uint8Array, limits: RenditionLimits): Promise<Rendition | null>
}
