// K014 · Infrastructure: decodificación y transformación con sharp/libvips. Las
// reglas de aceptación están en Domain; aquí solo se leen metadatos y se codifica.

import sharp from "sharp"
import type { ImageProcessor } from "../../application/photos/ports.js"
import { PHOTO_LIMITS } from "../../domain/photos.js"

// Un archivo por worker (anexos I p. 25): sin caché ni hilos adicionales de libvips.
sharp.cache(false)
sharp.concurrency(1)

const QUALITIES = [82, 72, 62, 52, 42] as const

export function createSharpImageProcessor(): ImageProcessor {
  return {
    async inspect(bytes) {
      try {
        const metadata = await sharp(bytes, { limitInputPixels: false }).metadata()
        return { format: metadata.format ?? "", width: metadata.width ?? 0, height: metadata.height ?? 0, pages: metadata.pages ?? 1 }
      } catch {
        return null
      }
    },
    async render(bytes, limits) {
      try {
        let last = null
        for (const quality of QUALITIES) {
          // limitInputPixels corta archivos que declaran más de 20 MP antes de decodificar.
          // rotate() aplica la orientación EXIF; la salida no conserva EXIF, ICC ni XMP.
          const { data, info } = await sharp(bytes, { limitInputPixels: PHOTO_LIMITS.maxPixels, failOn: "error", animated: false })
            .rotate()
            .resize({ width: limits.maxSide, height: limits.maxSide, fit: "inside", withoutEnlargement: true })
            .webp({ quality, effort: 4 })
            .toBuffer({ resolveWithObject: true })
          last = { bytes: new Uint8Array(data), width: info.width, height: info.height }
          if (data.length <= limits.maxBytes) return last
        }
        return last
      } catch {
        return null
      }
    },
  }
}
