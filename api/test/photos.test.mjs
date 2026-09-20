import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtemp, chmod, stat, readFile, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { localPhotoStore } from "../dist/prototypes/photos/local.js"

test("persistencia real entre procesos, permisos 0700/0600, lectura exacta y borrado", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rescate-k005-"))
  const key = `k005-${randomUUID()}.png`
  const cli = (operation) => execFileSync(process.execPath,
    ["dist/prototypes/photos/cli.js", "local", operation, key],
    { env: { ...process.env, PHOTO_LOCAL_DIR: directory }, encoding: "utf8" })
  try {
    assert.match(cli("upload"), /"result":"PASS"/)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(join(directory, key))).mode & 0o777, 0o600)
    assert.deepEqual(await readFile(join(directory, key)), await readFile("fixtures/k005.png"))
    assert.match(cli("read"), /"result":"PASS"/)
    assert.match(cli("delete"), /"result":"PASS"/)
    assert.match(cli("absent"), /"result":"PASS"/)
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("rechaza sobrescrituras, traversal, enlaces simbólicos y permisos públicos", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rescate-k005-"))
  const key = `k005-${randomUUID()}.png`
  try {
    const store = await localPhotoStore(directory)
    const bytes = await readFile("fixtures/k005.png")
    await store.put(key, bytes)
    await assert.rejects(store.put(key, bytes), { code: "EEXIST" })
    await assert.rejects(store.get("../fixtures/k005.png"), /inválida/)
    const linkKey = `k005-${randomUUID()}.png`
    await symlink(join(directory, key), join(directory, linkKey))
    await assert.rejects(store.get(linkKey), /archivo real/)
    await chmod(join(directory, key), 0o644)
    await assert.rejects(store.get(key), /0600/)
    await chmod(directory, 0o755)
    await assert.rejects(localPhotoStore(directory), /0700/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("S3 sin configuración falla sin red ni credenciales impresas", () => {
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith("PHOTO_S3_")) delete env[name]
  const result = spawnSync(process.execPath, ["dist/prototypes/photos/cli.js", "s3", "smoke"],
    { env, encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /FAIL K005/)
})
