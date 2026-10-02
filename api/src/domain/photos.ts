// K014 · Domain: reglas puras de las fotos de un lote (RF02, anexos I p. 25).
// No conoce HTTP, SQL, almacenamiento ni la librería de imágenes: recibe bytes,
// metadatos ya leídos y el instante relevante como valores.

export type PhotoStatus = "uploading" | "pending" | "ready" | "rejected" | "removed"
export type ImageFormat = "jpeg" | "png" | "webp"
export type PhotoVariant = "display" | "thumbnail"

/** Motivos por los que el worker rechaza un archivo ya recibido. */
export type PhotoRejection =
  | "unsupported_format"
  | "animated"
  | "too_many_pixels"
  | "undecodable"
  | "output_too_large"
  | "processing_failed"

export interface RenditionLimits { maxSide: number; maxBytes: number }

// Límites de E1 I p. 25. KB/MB se concretan en KiB/MiB como el límite JSON de S02.
export const PHOTO_LIMITS = {
  maxPhotosPerLot: 3,
  maxUploadBytes: 5 * 1024 * 1024,
  maxPixels: 20_000_000,
  uploadWindowMs: 5 * 60 * 1000,
  maxConcurrentUploads: 2,
  /** Intentos de validación antes de rechazar por fallo técnico repetido. */
  maxAttempts: 3,
  display: { maxSide: 1600, maxBytes: 500 * 1024 },
  thumbnail: { maxSide: 400, maxBytes: 100 * 1024 },
} as const

export type PhotoRuleReason =
  | "photo_limit_reached"
  | "unrecognized_image"
  | "photo_not_draft"

export class PhotoRuleError extends Error {
  readonly reason: PhotoRuleReason

  constructor(reason: PhotoRuleReason) {
    super(`Regla de fotos incumplida: ${reason}`)
    this.name = "PhotoRuleError"
    this.reason = reason
  }
}

/**
 * Formato según los bytes reales, no la extensión ni el MIME declarado. Solo
 * reconoce las firmas permitidas; un archivo falso o SVG devuelve null.
 */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  const starts = (signature: readonly number[], offset = 0) =>
    bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value)
  if (starts([0xff, 0xd8, 0xff])) return "jpeg"
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png"
  // RIFF....WEBP
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "webp"
  return null
}

/**
 * Un PNG animado (APNG) declara `acTL` antes de los datos de imagen. Los
 * decodificadores muestran solo el primer cuadro, por eso se revisa aquí.
 */
export function isAnimatedPng(bytes: Uint8Array): boolean {
  if (detectImageFormat(bytes) !== "png") return false
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!)
    if (type === "acTL") return true
    if (type === "IDAT" || type === "IEND") return false
    offset += 12 + length
  }
  return false
}

/** Metadatos del archivo decodificado, independientes de la librería que los lee. */
export interface SourceImage {
  format: string
  width: number
  height: number
  /** Cuadros del archivo; más de uno es una animación. */
  pages: number
}

/** Decide si el archivo recibido puede transformarse. Null significa aceptado. */
export function checkSourceImage(source: SourceImage, bytes: Uint8Array): PhotoRejection | null {
  if (!["jpeg", "png", "webp"].includes(source.format)) return "unsupported_format"
  if (detectImageFormat(bytes) !== source.format) return "unsupported_format"
  if (!(Number.isInteger(source.width) && Number.isInteger(source.height)) || source.width < 1 || source.height < 1) {
    return "undecodable"
  }
  if (source.pages > 1 || isAnimatedPng(bytes)) return "animated"
  if (source.width * source.height > PHOTO_LIMITS.maxPixels) return "too_many_pixels"
  return null
}

export interface Rendition { bytes: Uint8Array; width: number; height: number }

/** Una salida que no cumple sus límites invalida la foto completa. */
export function checkRendition(rendition: Rendition, limits: RenditionLimits): PhotoRejection | null {
  if (rendition.bytes.length < 1 || rendition.bytes.length > limits.maxBytes) return "output_too_large"
  if (Math.max(rendition.width, rendition.height) > limits.maxSide || Math.min(rendition.width, rendition.height) < 1) {
    return "output_too_large"
  }
  return null
}

/** Una foto ocupa su lugar mientras se carga, se valida o queda visible. */
export function isActivePhoto(photo: { status: PhotoStatus; uploadExpiresAt: Date }, now: Date): boolean {
  if (photo.status === "removed") return false
  return photo.status !== "uploading" || photo.uploadExpiresAt.getTime() > now.getTime()
}

/**
 * Solo un borrador acepta fotos nuevas o quitar fotos: publicado, su contenido
 * queda fijo (RF02). Devuelve la primera posición libre entre 1 y 3.
 */
export function nextPhotoPosition(lotStatus: string, activePositions: readonly number[]): number {
  if (lotStatus !== "draft") throw new PhotoRuleError("photo_not_draft")
  for (let position = 1; position <= PHOTO_LIMITS.maxPhotosPerLot; position++) {
    if (!activePositions.includes(position)) return position
  }
  throw new PhotoRuleError("photo_limit_reached")
}

export function requireDraftForPhotoChange(lotStatus: string): void {
  if (lotStatus !== "draft") throw new PhotoRuleError("photo_not_draft")
}

/** D-05: publicar exige que toda foto asociada esté lista; no se omiten en silencio. */
export function allPhotosReady(statuses: readonly PhotoStatus[]): boolean {
  return statuses.every((status) => status === "ready")
}

/** Las claves de objeto derivan del ID aleatorio de la foto, nunca del nombre aportado. */
export function photoObjectKeys(photoId: string): { upload: string; display: string; thumbnail: string } {
  return {
    upload: `uploads/${photoId}`,
    display: `photos/${photoId}/display.webp`,
    thumbnail: `photos/${photoId}/thumbnail.webp`,
  }
}
