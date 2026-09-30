import { mkdir, lstat, open, readFile, unlink } from "node:fs/promises"
import { resolve, join } from "node:path"

// Solo para el fixture de K005: no es almacenamiento de producción ni una API HTTP.
export async function localPhotoStore(directory: string) {
  const root = resolve(directory)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root)
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) {
    throw new Error("El directorio local debe ser real y tener permisos 0700")
  }
  const path = (key: string) => {
    if (!/^k005-[0-9a-f-]{36}\.png$/.test(key)) throw new Error("Clave K005 inválida")
    return join(root, key)
  }
  return {
    async put(key: string, bytes: Buffer) {
      const file = await open(path(key), "wx", 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
    },
    async get(key: string) {
      const info = await lstat(path(key))
      if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
        throw new Error("El objeto local debe ser un archivo real con permisos 0600")
      }
      return readFile(path(key))
    },
    async remove(key: string) {
      await unlink(path(key))
    },
  }
}
