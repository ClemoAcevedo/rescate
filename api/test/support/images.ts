// Archivos de prueba K014 generados en memoria: no se versionan imágenes binarias.
import { crc32 } from "node:zlib"
import sharp from "sharp"

const solid = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 3, background } })

/** JPEG con EXIF (autor, copyright y orientación 6) para comprobar que se elimina. */
export const jpegWithExif = (width = 2400, height = 1800) =>
  solid(width, height, "#3a7").jpeg({ quality: 90 }).withMetadata({ orientation: 6 })
    .withExif({ IFD0: { Artist: "Persona ficticia", Copyright: "Dato privado de prueba" } })
    .toBuffer()

/** Ruido: no se comprime bien, sirve para límites de tamaño. */
export async function noisyPng(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3)
  let seed = 12345
  for (let index = 0; index < pixels.length; index++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    pixels[index] = seed & 0xff
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer()
}

export const pngOf = (width: number, height: number) => solid(width, height, "#c84").png().toBuffer()

export async function animatedWebp(): Promise<Buffer> {
  const frames = await Promise.all(["#f00", "#00f"].map(color => solid(40, 40, color).png().toBuffer()))
  return sharp(frames, { join: { animated: true } }).webp().toBuffer()
}

/** PNG válido con un chunk acTL antes de IDAT: un APNG que libvips leería como estático. */
export async function animatedPng(): Promise<Buffer> {
  const png = await pngOf(40, 40)
  const data = Buffer.alloc(8)
  data.writeUInt32BE(2, 0)
  const type = Buffer.from("acTL")
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0)
  const afterHeader = 8 + 25 // firma + IHDR completo
  return Buffer.concat([png.subarray(0, afterHeader), length, type, data, crc, png.subarray(afterHeader)])
}

export const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')
export const fakePng = () => Buffer.from("esto no es una imagen, aunque se llame foto.png")
export const truncatedJpeg = async () => (await jpegWithExif(800, 600)).subarray(0, 600)

/** Archivo límite: ~20 MP con detalle y el JPEG más pesado que cabe en 5 MiB. */
export async function limitJpeg(): Promise<Buffer> {
  const width = 5163, height = 3872 // 19 991 136 píxeles
  const pixels = Buffer.alloc(width * height * 3)
  let seed = 1
  for (let index = 0; index < pixels.length; index++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    pixels[index] = (seed >> 16) & 0xff
  }
  for (let quality = 90; quality >= 30; quality -= 5) {
    const jpeg = await sharp(pixels, { raw: { width, height, channels: 3 } }).blur(1.2).jpeg({ quality }).toBuffer()
    if (jpeg.length <= 5 * 1024 * 1024) return jpeg
  }
  throw new Error("No se pudo generar el archivo límite")
}
