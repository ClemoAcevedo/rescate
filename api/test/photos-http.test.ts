// K014 · Transporte HTTP de fotos: límites binarios, errores y contrato OpenAPI.
// Los casos de uso son dobles; la integración real está en scripts/test-photos.mjs.
import assert from "node:assert/strict"
import { once } from "node:events"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { createApp } from "../src/app.js"
import { ConcurrentUploadsError, notAuthorized, photoNotFound } from "../src/application/errors.js"
import type { LotPhoto } from "../src/application/photos/ports.js"
import type { PhotoUseCases } from "../src/application/photos/use-cases.js"
import { PHOTO_LIMITS, PhotoRuleError, detectImageFormat } from "../src/domain/photos.js"
import { createPhotosRouter } from "../src/http/photos-router.js"
import { pngOf } from "./support/images.js"
import { assertContract } from "./support/openapi.js"

const LOT = "11111111-1111-4111-8111-111111111111"
const PHOTO = "22222222-2222-4222-8222-222222222222"
const photo = (overrides: Partial<LotPhoto> = {}): LotPhoto => ({
  publicId: PHOTO, position: 1, status: "pending", uploadedBy: "1", createdAt: new Date("2026-09-30T12:00:00Z"),
  uploadExpiresAt: new Date("2026-09-30T12:05:00Z"), format: null, width: null, height: null, rejectionReason: null,
  ...overrides,
})

async function start(cases: Partial<PhotoUseCases>) {
  const fail = async () => { throw new Error("no esperado") }
  const useCases: PhotoUseCases = { upload: fail, list: fail, remove: fail, read: fail, processNext: fail, cleanup: fail, ...cases }
  const app = createApp({ photosRouter: createPhotosRouter({
    useCases,
    authenticate: async request => request.header("x-test-actor") ? { userId: request.header("x-test-actor")! } : null,
    protectCommand: async request => { if (request.header("x-test-csrf") !== "ok") throw notAuthorized() },
    log: () => {},
  }) })
  const server: Server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    async call(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string>; actor?: string | null } = {}) {
      const headers: Record<string, string> = { "x-test-csrf": "ok", ...init.headers }
      if (init.actor !== null) headers["x-test-actor"] = init.actor ?? "1"
      const response = await fetch(base + path, { method, body: init.body, headers, duplex: "half" } as RequestInit)
      const type = response.headers.get("content-type") ?? ""
      const body = type.includes("json") ? await response.json() : type.startsWith("image/") ? new Uint8Array(await response.arrayBuffer()) : undefined
      if (!type.startsWith("image/")) assertContract(method, path, response, body)
      return { status: response.status, headers: response.headers, body }
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

test("carga: lee el binario después de autorizar y responde 202 según contrato", async () => {
  const png = await pngOf(20, 20)
  let received: Uint8Array | null = null
  const api = await start({ async upload(actor, input) {
    assert.equal(actor.userId, "1")
    assert.equal(input.lotId, LOT)
    received = await input.readContent(PHOTO_LIMITS.maxUploadBytes)
    return photo()
  } })
  try {
    const response = await api.call("POST", `/lots/${LOT}/photos`, { body: png, headers: { "content-type": "image/png" } })
    assert.equal(response.status, 202)
    assert.equal(response.body.status, "pending")
    assert.equal(response.body.thumbnailUrl, null)
    assert.deepEqual(Buffer.from(received!), png)
    assert.equal(detectImageFormat(received!), "png")
  } finally { await api.close() }
})

test("carga: sesión, CSRF y tipo declarado se comprueban antes de leer bytes", async () => {
  let calls = 0
  const api = await start({ async upload() { calls++; return photo() } })
  try {
    assert.equal((await api.call("POST", `/lots/${LOT}/photos`, { body: "x", headers: { "content-type": "image/png" }, actor: null })).status, 401)
    assert.equal((await api.call("POST", `/lots/${LOT}/photos`, { body: "x", headers: { "content-type": "image/png", "x-test-csrf": "no" } })).status, 403)
    for (const type of ["image/svg+xml", "image/gif", "application/json", "text/plain"]) {
      const response = await api.call("POST", `/lots/${LOT}/photos`, { body: "{}", headers: { "content-type": type } })
      assert.equal(response.status, 415, type)
    }
    assert.equal(calls, 0)
  } finally { await api.close() }
})

test("carga: más de 5 MiB responde 413, declarado o por streaming", async () => {
  let calls = 0
  let streamed: unknown = null
  const api = await start({ async upload(_actor, input) {
    calls++
    try { await input.readContent(PHOTO_LIMITS.maxUploadBytes) } catch (error) { streamed = error; throw error }
    return photo()
  } })
  try {
    const big = new Uint8Array(PHOTO_LIMITS.maxUploadBytes + 1)
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    assert.equal((await api.call("POST", `/lots/${LOT}/photos`, { body: big, headers: { "content-type": "image/png" } })).status, 413)
    assert.equal(calls, 0, "Content-Length excesivo no reserva una carga")
    // Sin Content-Length (chunked): el límite se aplica al leer, después de reservar.
    const stream = new ReadableStream({ start(controller) { controller.enqueue(big); controller.close() } })
    const chunked = await api.call("POST", `/lots/${LOT}/photos`, { body: stream, headers: { "content-type": "image/png" } })
    assert.equal(chunked.status, 413)
    assert.equal(calls, 1)
    assert.ok(streamed, "Application recibe el error y libera la carga")
  } finally { await api.close() }
})

test("errores semánticos: 422 firma falsa, 409 límite o publicado, 429 con Retry-After", async () => {
  const errors = [new PhotoRuleError("unrecognized_image"), new PhotoRuleError("photo_limit_reached"),
    new PhotoRuleError("photo_not_draft"), new ConcurrentUploadsError(42)]
  const api = await start({ async upload() { throw errors.shift() } })
  try {
    const send = () => api.call("POST", `/lots/${LOT}/photos`, { body: "x", headers: { "content-type": "image/jpeg" } })
    const invalid = await send()
    assert.equal(invalid.status, 422)
    assert.equal(invalid.body.error.details.issues[0].path, "")
    assert.equal((await send()).status, 409)
    assert.equal((await send()).status, 409)
    const limited = await send()
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get("retry-after"), "42")
  } finally { await api.close() }
})

test("listado y retiro del operador según contrato", async () => {
  const ready = photo({ status: "ready", format: "jpeg", width: 1600, height: 1200 })
  const rejected = photo({ publicId: "33333333-3333-4333-8333-333333333333", position: 2, status: "rejected", rejectionReason: "animated" })
  const removed: string[] = []
  const api = await start({
    async list() { return [ready, rejected] },
    async remove(_actor, lotId, photoId) { removed.push(`${lotId}/${photoId}`) },
  })
  try {
    const list = await api.call("GET", `/lots/${LOT}/photos`)
    assert.equal(list.status, 200)
    assert.equal(list.body.items[0].thumbnailUrl, `/lots/${LOT}/photos/${PHOTO}/thumbnail`)
    assert.equal(list.body.items[0].displayUrl, `/lots/${LOT}/photos/${PHOTO}/display`)
    assert.equal(list.body.items[1].rejectionReason, "animated")
    assert.equal(list.body.items[1].displayUrl, null)
    assert.equal((await api.call("GET", `/lots/${LOT}/photos`, { actor: null })).status, 401)
    assert.equal((await api.call("DELETE", `/lots/${LOT}/photos/${PHOTO}`, { headers: { "x-test-csrf": "no" } })).status, 403)
    assert.equal((await api.call("DELETE", `/lots/${LOT}/photos/${PHOTO}`)).status, 204)
    assert.deepEqual(removed, [`${LOT}/${PHOTO}`])
  } finally { await api.close() }
})

test("imagen: WebP con caché privada si está publicada y no-store en borrador", async () => {
  const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])
  const seen: Array<string | null> = []
  const api = await start({ async read(actor, _lot, photoId, variant) {
    seen.push(actor?.userId ?? null)
    if (photoId !== PHOTO) throw photoNotFound()
    return { bytes, published: variant === "display" }
  } })
  try {
    const published = await api.call("GET", `/lots/${LOT}/photos/${PHOTO}/display`, { actor: null })
    assert.equal(published.status, 200)
    assert.equal(published.headers.get("content-type"), "image/webp")
    assert.equal(published.headers.get("cache-control"), "private, max-age=3600")
    assert.equal(published.headers.get("x-content-type-options"), "nosniff")
    assert.deepEqual(published.body, bytes)
    const draft = await api.call("GET", `/lots/${LOT}/photos/${PHOTO}/thumbnail`)
    assert.equal(draft.headers.get("cache-control"), "no-store")
    assert.deepEqual(seen, [null, "1"])
    assert.equal((await api.call("GET", `/lots/${LOT}/photos/${PHOTO}/original`)).status, 404)
    assert.equal((await api.call("GET", `/lots/${LOT}/photos/otra/display`)).status, 404)
  } finally { await api.close() }
})
