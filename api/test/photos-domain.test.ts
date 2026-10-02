// K014 · Reglas puras de fotos y transformación real con sharp, sin red ni base.
import assert from "node:assert/strict"
import test from "node:test"
import sharp from "sharp"
import {
  PHOTO_LIMITS, PhotoRuleError, allPhotosReady, checkRendition, checkSourceImage, detectImageFormat,
  isActivePhoto, isAnimatedPng, nextPhotoPosition, photoObjectKeys,
} from "../src/domain/photos.js"
import { LotRuleError, publishLot } from "../src/domain/lots.js"
import type { Lot } from "../src/domain/lots.js"
import { createSharpImageProcessor } from "../src/infrastructure/images/sharp-image-processor.js"
import { animatedPng, animatedWebp, fakePng, jpegWithExif, noisyPng, pngOf, svg, truncatedJpeg } from "./support/images.js"

const processor = createSharpImageProcessor()

test("la firma de los bytes decide el formato, no el nombre ni el MIME", async () => {
  assert.equal(detectImageFormat(await jpegWithExif(40, 30)), "jpeg")
  assert.equal(detectImageFormat(await pngOf(10, 10)), "png")
  assert.equal(detectImageFormat(await animatedWebp()), "webp")
  assert.equal(detectImageFormat(fakePng()), null)
  assert.equal(detectImageFormat(svg()), null)
  assert.equal(detectImageFormat(new Uint8Array()), null)
})

test("un APNG se reconoce por acTL aunque libvips lo lea como un cuadro", async () => {
  const apng = await animatedPng()
  assert.equal(isAnimatedPng(apng), true)
  assert.equal(isAnimatedPng(await pngOf(10, 10)), false)
  const info = await processor.inspect(apng)
  assert.ok(info)
  assert.equal(checkSourceImage(info, apng), "animated")
})

test("el worker rechaza SVG, animaciones, más de 20 MP y archivos truncados", async () => {
  const vector = svg()
  const vectorInfo = await processor.inspect(vector)
  assert.equal(vectorInfo && checkSourceImage(vectorInfo, vector), "unsupported_format")

  const animated = await animatedWebp()
  const animatedInfo = await processor.inspect(animated)
  assert.equal(animatedInfo && checkSourceImage(animatedInfo, animated), "animated")

  // 5000 × 4001 = 20 005 000 píxeles: supera el límite aunque el archivo pese poco.
  const huge = await pngOf(5000, 4001)
  assert.ok(huge.length < PHOTO_LIMITS.maxUploadBytes)
  const hugeInfo = await processor.inspect(huge)
  assert.equal(hugeInfo && checkSourceImage(hugeInfo, huge), "too_many_pixels")
  assert.equal(await processor.render(huge, PHOTO_LIMITS.display), null, "libvips también corta antes de decodificar")

  const truncated = await truncatedJpeg()
  assert.equal(detectImageFormat(truncated), "jpeg")
  assert.equal(await processor.render(truncated, PHOTO_LIMITS.display), null)

  assert.equal(checkSourceImage({ format: "png", width: 10, height: 10, pages: 1 }, await jpegWithExif(10, 10)), "unsupported_format",
    "metadatos y firma deben coincidir")
})

test("imagen y miniatura WebP sin EXIF, orientadas y dentro de sus límites", async () => {
  const source = await jpegWithExif()
  const info = await processor.inspect(source)
  assert.ok(info)
  assert.equal(checkSourceImage(info, source), null)
  assert.equal((await sharp(source).metadata()).exif !== undefined, true, "el fixture trae EXIF")

  const display = await processor.render(source, PHOTO_LIMITS.display)
  assert.ok(display)
  assert.equal(checkRendition(display, PHOTO_LIMITS.display), null)
  // Orientación 6 rota 90°: 2400 × 1800 queda vertical, con lado mayor 1600.
  assert.deepEqual([display.width, display.height], [1200, 1600])
  const thumbnail = await processor.render(display.bytes, PHOTO_LIMITS.thumbnail)
  assert.ok(thumbnail)
  assert.equal(checkRendition(thumbnail, PHOTO_LIMITS.thumbnail), null)
  assert.deepEqual([thumbnail.width, thumbnail.height], [300, 400])

  for (const output of [display, thumbnail]) {
    const metadata = await sharp(output.bytes).metadata()
    assert.equal(metadata.format, "webp")
    assert.equal(metadata.exif, undefined)
    assert.equal(metadata.xmp, undefined)
    assert.equal(Buffer.from(output.bytes).includes("Dato privado de prueba"), false)
  }
})

test("una imagen difícil de comprimir baja la calidad hasta caber o se rechaza", async () => {
  const noisy = await noisyPng(1600, 1600)
  const display = await processor.render(noisy, PHOTO_LIMITS.display)
  assert.ok(display)
  assert.ok(display.bytes.length <= PHOTO_LIMITS.display.maxBytes || checkRendition(display, PHOTO_LIMITS.display) === "output_too_large")
  assert.equal(checkRendition({ ...display, bytes: new Uint8Array(PHOTO_LIMITS.display.maxBytes + 1) }, PHOTO_LIMITS.display), "output_too_large")
  assert.equal(checkRendition({ ...display, width: 1601 }, PHOTO_LIMITS.display), "output_too_large")
})

test("posiciones: solo borradores, hasta tres fotos activas", () => {
  assert.equal(nextPhotoPosition("draft", []), 1)
  assert.equal(nextPhotoPosition("draft", [1, 3]), 2)
  assert.throws(() => nextPhotoPosition("draft", [1, 2, 3]), (error: unknown) =>
    error instanceof PhotoRuleError && error.reason === "photo_limit_reached")
  assert.throws(() => nextPhotoPosition("published", []), (error: unknown) =>
    error instanceof PhotoRuleError && error.reason === "photo_not_draft")
  const now = new Date("2026-09-30T12:00:00Z")
  assert.equal(isActivePhoto({ status: "uploading", uploadExpiresAt: new Date(now.getTime() + 1) }, now), true)
  assert.equal(isActivePhoto({ status: "uploading", uploadExpiresAt: now }, now), false)
  assert.equal(isActivePhoto({ status: "removed", uploadExpiresAt: new Date(now.getTime() + 1) }, now), false)
  assert.deepEqual(photoObjectKeys("abc"), { upload: "uploads/abc", display: "photos/abc/display.webp", thumbnail: "photos/abc/thumbnail.webp" })
})

test("D-05: publicar exige que todas las fotos activas estén listas", () => {
  const now = new Date("2026-09-30T12:00:00Z")
  const lot: Lot = {
    publicId: "l", establishmentId: "1", establishmentPublicId: "e", status: "draft", version: 1,
    createdAt: now, updatedAt: now, publishedAt: null,
    declaration: { description: "Pack", category: "Pan", quantity: 1, conditions: null, address: "Calle 1",
      latitude: 0, longitude: 0, timeZone: "America/Santiago",
      pickupStartsAt: new Date("2026-10-01T10:00:00Z"), pickupEndsAt: new Date("2026-10-01T12:00:00Z") },
  }
  assert.equal(allPhotosReady([]), true)
  assert.equal(publishLot(lot, now, ["ready", "ready"]).status, "published")
  for (const pending of ["pending", "rejected", "uploading"] as const) {
    assert.throws(() => publishLot(lot, now, ["ready", pending]), (error: unknown) =>
      error instanceof LotRuleError && error.violations.includes("photo_not_ready"))
  }
})
