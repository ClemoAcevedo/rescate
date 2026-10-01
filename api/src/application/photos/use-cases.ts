// K014 · Application: carga, validación, lectura y limpieza de fotos de lotes.
// Coordina autorización, reglas de Domain y unidades atómicas. Las llamadas al
// almacenamiento ocurren fuera de las transacciones que bloquean el lote.

import {
  PHOTO_LIMITS, PhotoRuleError, checkRendition, checkSourceImage, detectImageFormat, isActivePhoto,
  nextPhotoPosition, photoObjectKeys, requireDraftForPhotoChange,
} from "../../domain/photos.js"
import type { PhotoRejection, PhotoVariant } from "../../domain/photos.js"
import {
  ConcurrentUploadsError, lotNotFound, notAuthorized, photoNotFound, photoStorageUnavailable, photoUploadExpired,
} from "../errors.js"
import type { Actor, Clock } from "../lots/ports.js"
import type { ImageProcessor, LotPhoto, ObjectStore, PhotoRepository, ProcessingResult } from "./ports.js"

export interface UploadPhotoInput {
  lotId: string
  /**
   * Lee el archivo hasta `maxBytes`. Se invoca después de autorizar y reservar
   * la carga, para no aceptar bytes de quien no puede cargar en este lote.
   */
  readContent(maxBytes: number): Promise<Uint8Array>
}

export interface PhotoContent { bytes: Uint8Array; published: boolean }

export interface PhotoUseCases {
  upload(actor: Actor, input: UploadPhotoInput): Promise<LotPhoto>
  list(actor: Actor, lotId: string): Promise<LotPhoto[]>
  remove(actor: Actor, lotId: string, photoId: string): Promise<void>
  /** Publicado: visible para cualquiera. Borrador: solo para operadores del establecimiento. */
  read(actor: Actor | null, lotId: string, photoId: string, variant: PhotoVariant): Promise<PhotoContent>
  /** Worker: valida y transforma una foto pendiente; false si no había trabajo. */
  processNext(): Promise<boolean>
  /** Worker: borra objetos temporales, vencidos o de fotos quitadas. Devuelve cuántos atendió. */
  cleanup(): Promise<number>
}

export interface PhotoDependencies {
  repository: PhotoRepository
  /** Null cuando el entorno no configuró almacenamiento: cargar responde no disponible. */
  objects: ObjectStore | null
  images: ImageProcessor | null
  now: Clock
  log?: (event: Record<string, unknown>) => void
}

/** Reclamo de una validación; al vencer, otro worker puede retomarla sin duplicar fotos. */
export const PROCESSING_LEASE_MS = 2 * 60 * 1000
/** Margen para que una carga que termina justo al vencer confirme o se retire sola. */
export const EXPIRED_UPLOAD_GRACE_MS = 60 * 1000

const rejected = (rejectionReason: PhotoRejection): ProcessingResult => ({ status: "rejected", rejectionReason })

export function createPhotoUseCases({ repository, objects, images, now, log = () => {} }: PhotoDependencies): PhotoUseCases {
  const requireObjects = (): ObjectStore => {
    if (objects === null) throw photoStorageUnavailable()
    return objects
  }

  /** Retiro de una carga fallida. Si falla, la limpieza periódica lo completa. */
  async function release(lotId: string, photoId: string, store: ObjectStore): Promise<void> {
    try {
      await repository.withLotPhotos(lotId, async (_lot, writer) => writer.removePhoto(photoId, now()))
      await store.remove(photoObjectKeys(photoId).upload)
      await repository.markObjectsDeleted(photoId, now())
    } catch {
      log({ event: "photo_release_deferred" })
    }
  }

  async function transform(source: Uint8Array, photoId: string, store: ObjectStore, processor: ImageProcessor): Promise<ProcessingResult> {
    const info = await processor.inspect(source)
    if (info === null) return rejected("undecodable")
    const sourceRejection = checkSourceImage(info, source)
    if (sourceRejection) return rejected(sourceRejection)
    const display = await processor.render(source, PHOTO_LIMITS.display)
    if (display === null) return rejected("undecodable")
    const displayRejection = checkRendition(display, PHOTO_LIMITS.display)
    if (displayRejection) return rejected(displayRejection)
    // La miniatura parte de la imagen ya transformada: no vuelve a decodificar el original.
    const thumbnail = await processor.render(display.bytes, PHOTO_LIMITS.thumbnail)
    if (thumbnail === null) return rejected("undecodable")
    const thumbnailRejection = checkRendition(thumbnail, PHOTO_LIMITS.thumbnail)
    if (thumbnailRejection) return rejected(thumbnailRejection)
    // Claves fijas por foto: repetir la validación tras un reinicio sobrescribe, no duplica.
    const keys = photoObjectKeys(photoId)
    await store.put(keys.display, display.bytes, "image/webp")
    await store.put(keys.thumbnail, thumbnail.bytes, "image/webp")
    return { status: "ready", format: info.format as ProcessingResult["format"], width: display.width, height: display.height }
  }

  async function removeObjects(store: ObjectStore, photoId: string): Promise<void> {
    const keys = photoObjectKeys(photoId)
    await store.remove(keys.upload)
    await store.remove(keys.display)
    await store.remove(keys.thumbnail)
  }

  return {
    async upload(actor, input) {
      const store = requireObjects()
      const at = now()
      const slot = await repository.withLotPhotos(input.lotId, async (lot, writer) => {
        if (lot === null) throw lotNotFound()
        if (!(await writer.isMemberOfEstablishment(actor.userId, lot.establishmentId))) throw notAuthorized()
        requireDraftForPhotoChange(lot.status)
        const active = await writer.listActivePhotos(at)
        const position = nextPhotoPosition(lot.status, active.map((photo) => photo.position))
        const uploads = await writer.activeUploadsOf(actor.userId, at)
        if (uploads.length >= PHOTO_LIMITS.maxConcurrentUploads) {
          const first = Math.min(...uploads.map((expiresAt) => expiresAt.getTime()))
          throw new ConcurrentUploadsError(Math.max(1, Math.ceil((first - at.getTime()) / 1000)))
        }
        return writer.insertUpload({
          uploadedBy: actor.userId, position, createdAt: at,
          expiresAt: new Date(at.getTime() + PHOTO_LIMITS.uploadWindowMs),
        })
      })

      try {
        const bytes = await input.readContent(PHOTO_LIMITS.maxUploadBytes)
        // La API solo acepta firmas permitidas; el worker decodifica y valida el resto.
        if (bytes.length < 1 || bytes.length > PHOTO_LIMITS.maxUploadBytes || detectImageFormat(bytes) === null) {
          throw new PhotoRuleError("unrecognized_image")
        }
        await store.put(photoObjectKeys(slot.publicId).upload, bytes, "application/octet-stream")
        const confirmed = await repository.withLotPhotos(input.lotId, async (lot, writer) =>
          lot?.status === "draft" ? writer.confirmUpload(slot.publicId, bytes.length, now()) : null)
        if (confirmed === null) throw photoUploadExpired()
        return confirmed
      } catch (error) {
        await release(input.lotId, slot.publicId, store)
        throw error
      }
    },

    async list(actor, lotId) {
      const found = await repository.findLotPhotos(lotId)
      if (found === null) throw lotNotFound()
      if (!(await repository.isMemberOfEstablishment(actor.userId, found.lot.establishmentId))) throw notAuthorized()
      const at = now()
      return found.photos.filter((photo) => isActivePhoto(photo, at))
    },

    async remove(actor, lotId, photoId) {
      await repository.withLotPhotos(lotId, async (lot, writer) => {
        if (lot === null) throw lotNotFound()
        if (!(await writer.isMemberOfEstablishment(actor.userId, lot.establishmentId))) throw notAuthorized()
        // Publicado, las fotos que describen el contenido quedan fijas (RF02).
        requireDraftForPhotoChange(lot.status)
        const target = (await writer.listActivePhotos(now())).find((photo) => photo.publicId === photoId.toLowerCase())
        if (target === undefined || !(await writer.removePhoto(target.publicId, now()))) throw photoNotFound()
      })
      // Los objetos se borran después del commit; la limpieza reintenta si falla.
      if (objects !== null) {
        try {
          await removeObjects(objects, photoId.toLowerCase())
          await repository.markObjectsDeleted(photoId.toLowerCase(), now())
        } catch {
          log({ event: "photo_cleanup_deferred" })
        }
      }
    },

    async read(actor, lotId, photoId, variant) {
      const store = requireObjects()
      const found = await repository.findLotPhotos(lotId)
      const photo = found?.photos.find((candidate) => candidate.publicId === photoId.toLowerCase() && candidate.status === "ready")
      if (found === null || photo === undefined) throw photoNotFound()
      const published = found.lot.status === "published"
      // Un borrador no confirma su existencia a quien no lo opera.
      if (!published && (actor === null || !(await repository.isMemberOfEstablishment(actor.userId, found.lot.establishmentId)))) {
        throw photoNotFound()
      }
      const bytes = await store.get(photoObjectKeys(photo.publicId)[variant])
      if (bytes === null) throw photoNotFound()
      return { bytes, published }
    },

    async processNext() {
      if (objects === null || images === null) return false
      const at = now()
      const claim = await repository.claimNextPending(at, new Date(at.getTime() + PROCESSING_LEASE_MS))
      if (claim === null) return false
      const keys = photoObjectKeys(claim.publicId)
      let result: ProcessingResult
      if (claim.attempts > PHOTO_LIMITS.maxAttempts) result = rejected("processing_failed")
      else {
        const source = await objects.get(keys.upload)
        result = source === null ? rejected("processing_failed") : await transform(source, claim.publicId, objects, images)
      }
      const finished = await repository.finishProcessing(claim.publicId, result, now())
      log({ event: "photo_processed", status: finished ? result.status : "removed", reason: result.rejectionReason ?? null })
      // El original temporal no forma parte del historial permanente (anexos I p. 28).
      // Si la quitaron durante la validación, la limpieza pudo adelantarse a estas salidas.
      try {
        if (finished) await objects.remove(keys.upload)
        else await removeObjects(objects, claim.publicId)
        await repository.markUploadDeleted(claim.publicId, now())
      } catch {
        log({ event: "photo_cleanup_deferred" })
      }
      return true
    },

    async cleanup() {
      if (objects === null) return 0
      const at = now()
      const expiredBefore = new Date(at.getTime() - EXPIRED_UPLOAD_GRACE_MS)
      let done = 0
      for (const item of await repository.listCleanup(expiredBefore, 50)) {
        try {
          if (item.kind === "processed") {
            await objects.remove(photoObjectKeys(item.publicId).upload)
            await repository.markUploadDeleted(item.publicId, now())
          } else {
            if (item.kind === "expired_upload" && !(await repository.expireUpload(item.publicId, expiredBefore, now()))) continue
            await removeObjects(objects, item.publicId)
            await repository.markObjectsDeleted(item.publicId, now())
          }
          done++
        } catch {
          log({ event: "photo_cleanup_deferred" })
        }
      }
      return done
    },
  }
}
