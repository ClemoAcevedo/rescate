// K014 · HTTP: transporte de fotos. Lee el cuerpo binario con su propio límite,
// fuera del parser JSON de 16 KiB, y traduce resultados según OpenAPI.
import { Router } from "express"
import type { Request, Response } from "express"
import type { PhotoUseCases } from "../application/photos/use-cases.js"
import type { LotPhoto } from "../application/photos/ports.js"
import { notAuthenticated } from "../application/errors.js"
import { PHOTO_LIMITS } from "../domain/photos.js"
import type { PhotoVariant } from "../domain/photos.js"
import type { Authenticate } from "./actor.js"
import type { HttpSchemas } from "./openapi.js"
import { handleError, sendError } from "./errors.js"
import type { Log } from "../application/logging.js"

export interface PhotosRouterOptions {
  maxPhotosPerLot?: number
  useCases: PhotoUseCases
  authenticate: Authenticate
  protectCommand: (request: Request) => Promise<void>
  log?: Log
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"]

/** Ruta de la imagen relativa a la base de la API, como las rutas de OpenAPI. */
export function photoPath(lotId: string, photoId: string, variant: PhotoVariant): string {
  return `/lots/${lotId}/photos/${photoId}/${variant}`
}

export function photoBody(lotId: string, photo: LotPhoto): HttpSchemas["LotPhoto"] {
  const ready = photo.status === "ready"
  return {
    id: photo.publicId,
    position: photo.position,
    status: photo.status as HttpSchemas["LotPhoto"]["status"],
    createdAt: photo.createdAt.toISOString(),
    width: ready ? photo.width : null,
    height: ready ? photo.height : null,
    rejectionReason: photo.rejectionReason,
    thumbnailUrl: ready ? photoPath(lotId, photo.publicId, "thumbnail") : null,
    displayUrl: ready ? photoPath(lotId, photo.publicId, "display") : null,
  }
}

class UploadTooLargeError extends Error {
  constructor(readonly request: Request) { super("upload_too_large") }
}
class UploadAbortedError extends Error {}

/** Acumula el cuerpo hasta `maxBytes`. Si se supera responde 413 y descarta el resto. */
function readLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const finish = (error: Error | null) => {
      if (settled) return
      settled = true
      request.off("data", onData).off("end", onEnd).off("error", onError).off("close", onClose)
      if (error) {
        request.resume()
        reject(error)
      } else resolve(new Uint8Array(Buffer.concat(chunks, total)))
    }
    const onData = (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) finish(new UploadTooLargeError(request))
      else chunks.push(chunk)
    }
    const onEnd = () => finish(null)
    const onError = () => finish(new UploadAbortedError())
    const onClose = () => finish(new UploadAbortedError())
    request.on("data", onData).on("end", onEnd).on("error", onError).on("close", onClose)
  })
}

/**
 * Tras el 413 el cliente puede seguir enviando la foto. Cerrar con bytes sin leer manda
 * un RST y el cliente pierde la respuesta (#171). Se descarta el resto hasta un tope y
 * solo quien lo supera o se demora pierde la conexión.
 */
const DISCARD_LIMIT_BYTES = 4 * PHOTO_LIMITS.maxUploadBytes
const DISCARD_TIMEOUT_MS = 10_000
function discardRest(request: Request): void {
  let discarded = 0
  const cut = () => request.socket.destroy()
  const timer = setTimeout(cut, DISCARD_TIMEOUT_MS)
  request.on("data", (chunk: Buffer) => {
    discarded += chunk.length
    if (discarded > DISCARD_LIMIT_BYTES) cut()
  })
  request.once("close", () => clearTimeout(timer))
  request.resume()
}

const id = (value: unknown): string => typeof value === "string" ? value : ""

export function createPhotosRouter({ useCases, authenticate, protectCommand, maxPhotosPerLot = PHOTO_LIMITS.maxPhotosPerLot, log = event => console.error(event) }: PhotosRouterOptions): Router {
  const router = Router()
  const fail = (error: unknown, response: Response) => {
    if (error instanceof UploadTooLargeError) {
      sendError(response, 413, "PAYLOAD_TOO_LARGE", "La foto supera 5 MiB.")
      discardRest(error.request)
    } else if (error instanceof UploadAbortedError) {
      if (!response.headersSent) sendError(response, 400, "MALFORMED_REQUEST", "La carga se interrumpió.")
    } else handleError(error, response, log)
  }
  const command = async (request: Request) => {
    const actor = await authenticate(request)
    if (actor === null) throw notAuthenticated()
    await protectCommand(request)
    return actor
  }

  router.post("/lots/:lotId/photos", async (request, response) => {
    try {
      const actor = await command(request)
      const type = (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase()
      if (!IMAGE_TYPES.includes(type)) {
        sendError(response, 415, "UNSUPPORTED_MEDIA_TYPE", "Se requiere image/jpeg, image/png o image/webp.")
        return
      }
      // Un tamaño declarado excesivo se rechaza antes de reservar la carga.
      const declared = Number(request.headers["content-length"])
      if (Number.isFinite(declared) && declared > PHOTO_LIMITS.maxUploadBytes) throw new UploadTooLargeError(request)
      const lotId = id(request.params.lotId)
      const photo = await useCases.upload(actor, { lotId, readContent: (maxBytes) => readLimited(request, maxBytes) })
      response.status(202).json(photoBody(lotId, photo))
    } catch (error) {
      fail(error, response)
    }
  })

  router.get("/lots/:lotId/photos", async (request, response) => {
    try {
      const actor = await authenticate(request)
      if (actor === null) throw notAuthenticated()
      const lotId = id(request.params.lotId)
      const photos = await useCases.list(actor, lotId)
      const body: HttpSchemas["LotPhotoList"] = { items: photos.map((photo) => photoBody(lotId, photo)) }
      response.json({ ...body, limit: maxPhotosPerLot })
    } catch (error) {
      fail(error, response)
    }
  })

  router.delete("/lots/:lotId/photos/:photoId", async (request, response) => {
    try {
      const actor = await command(request)
      await useCases.remove(actor, id(request.params.lotId), id(request.params.photoId))
      response.status(204).end()
    } catch (error) {
      fail(error, response)
    }
  })

  router.get("/lots/:lotId/photos/:photoId/:variant", async (request, response) => {
    try {
      const variant = id(request.params.variant)
      if (variant !== "display" && variant !== "thumbnail") {
        sendError(response, 404, "NOT_FOUND", "Recurso inexistente.")
        return
      }
      // Sin sesión se sirven solo fotos de lotes publicados.
      const actor = await authenticate(request)
      const photo = await useCases.read(actor, id(request.params.lotId), id(request.params.photoId), variant)
      response
        .set("Content-Type", "image/webp")
        .set("X-Content-Type-Options", "nosniff")
        .set("Content-Security-Policy", "default-src 'none'")
        // El contenido de una foto publicada no cambia; la de un borrador puede quitarse.
        .set("Cache-Control", photo.published ? "private, max-age=3600" : "no-store")
        .send(Buffer.from(photo.bytes.buffer, photo.bytes.byteOffset, photo.bytes.byteLength))
    } catch (error) {
      fail(error, response)
    }
  })

  return router
}
