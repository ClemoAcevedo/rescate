// K014 · Infrastructure: objetos en un directorio local para desarrollo, Compose y
// pruebas. No es almacenamiento de producción: Composition lo rechaza allí.

import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { ObjectStore } from "../../application/photos/ports.js"

// Solo las claves que deriva Domain: impide traversal y nombres aportados por usuarios.
const KEY_PATTERN = /^(uploads\/[0-9a-f-]{36}|photos\/[0-9a-f-]{36}\/(display|thumbnail)\.webp)$/

export function createLocalObjectStore(directory: string): ObjectStore {
  const root = resolve(directory, "lot-photos")
  const path = (key: string): string => {
    if (!KEY_PATTERN.test(key)) throw new Error("Clave de objeto no permitida")
    return join(root, key)
  }
  return {
    async put(key, bytes) {
      const target = path(key)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      // Escritura completa y renombre atómico: un lector nunca ve un archivo a medias.
      const temporary = `${target}.${randomUUID()}.tmp`
      const file = await open(temporary, "wx", 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
      try {
        await rename(temporary, target)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(path(key)))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
      }
    },
    async remove(key) {
      await rm(path(key), { force: true })
    },
  }
}
