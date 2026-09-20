import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { localPhotoStore } from "./local.js"
import { remoteSmoke } from "./s3.js"

// Fixture fijo: K005 no procesa entradas de usuarios (responsabilidad de K014).
const fixture = new URL("../../../fixtures/k005.png", import.meta.url)

try {
  const [mode, operation, key] = process.argv.slice(2)
  const bytes = await readFile(fixture)
  if (mode === "s3" && operation === "smoke") {
    await remoteSmoke(bytes)
  } else if (mode === "local" && key && ["upload", "read", "delete", "absent"].includes(operation)) {
    const store = await localPhotoStore(process.env.PHOTO_LOCAL_DIR ?? ".k005-storage")
    if (operation === "upload") await store.put(key, bytes)
    if (operation === "read") assert.deepEqual(await store.get(key), bytes)
    if (operation === "delete") await store.remove(key)
    if (operation === "absent") {
      await assert.rejects(store.get(key), { code: "ENOENT" })
    }
    console.log(JSON.stringify({ result: "PASS", mode, operation, key,
      bytes: bytes.length, fixtureSha256: createHash("sha256").update(bytes).digest("hex") }))
  } else {
    throw new Error("Uso: photos local upload|read|delete|absent k005-<UUID>.png | photos s3 smoke")
  }
} catch (error) {
  // No serializar errores del SDK: pueden contener URLs firmadas y datos de configuración.
  const safeName = error instanceof Error ? error.name.replace(/[^a-zA-Z0-9_]/g, "") : "Error"
  console.error(`FAIL K005 (${safeName}). Revisar configuración y último paso PASS; ver docs/k005-fotos.md.`)
  process.exitCode = 1
}
