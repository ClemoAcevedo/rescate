// K034 · Registros sin secretos: solo eventos primitivos y códigos técnicos acotados. La
// salida real de la API con PostgreSQL se revisa en scripts/test-security.mjs.
import test from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { Router } from "express"
import { createApp } from "../src/app.js"
import { errorCode } from "../src/application/logging.js"
import type { LogEvent } from "../src/application/logging.js"

const secrets = ["MiClaveSecreta123", "\\x9f86d081884c7d65", "7K2M9QXR", "ana@example.com"]

test("errorCode conserva SQLSTATE, errores de sistema y de Node; todo lo demás es INTERNAL", () => {
  for (const code of ["23505", "55P03", "57P01", "08006", "ECONNRESET", "ENOTFOUND", "ERR_INVALID_URL"]) {
    assert.equal(errorCode(Object.assign(new Error("x"), { code })), code)
  }
  // La forma de un código de retiro, códigos semánticos y valores sin código no pasan.
  for (const code of ["7K2M9QXR", "EABCDEFG", "lot_not_found", "INTERNAL_X", "", "23505 ", undefined]) {
    assert.equal(errorCode(Object.assign(new Error("x"), { code })), "INTERNAL")
  }
  assert.equal(errorCode("23505"), "INTERNAL")
  assert.equal(errorCode(null), "INTERNAL")
})

async function serve(router: Router) {
  const events: LogEvent[] = []
  const printed: unknown[] = []
  const original = console.error
  console.error = (...values: unknown[]) => { printed.push(values) }
  const server = createApp({ lotsRouter: router, log: event => events.push(event) }).listen(0, "127.0.0.1")
  await once(server, "listening")
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, events, printed, async close() {
    console.error = original
    await new Promise(resolve => server.close(resolve))
  } }
}

test("un fallo inesperado responde genérico y registra solo el código, sin detalle de PostgreSQL", async () => {
  const router = Router()
  router.post("/lots/:lotId/fails", () => {
    throw Object.assign(new Error(`duplicate key value violates unique constraint (${secrets[3]})`), {
      code: "23505", detail: `Key (token_hash)=(${secrets[1]}) already exists.`,
      where: `password=${secrets[0]}`,
    })
  })
  const s = await serve(router)
  try {
    const response = await fetch(`${s.base}/lots/${secrets[2]}/fails?email=${secrets[3]}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: "{}" })
    const text = await response.text()
    assert.equal(response.status, 500)
    assert.equal(response.headers.get("x-powered-by"), null)
    assert.equal(response.headers.get("x-content-type-options"), "nosniff")
    // K036: el fallo y la solicitud comparten un identificador generado; la operación es la
    // plantilla de la ruta, sin el valor del parámetro ni la consulta.
    const [failed, request] = s.events
    assert.match(String(failed?.requestId), /^[0-9a-f-]{36}$/)
    assert.deepEqual(failed, { event: "request_failed", requestId: failed?.requestId, code: "23505" })
    assert.deepEqual({ ...request, durationMs: 0 }, { event: "request", requestId: failed?.requestId,
      operation: "POST /lots/:lotId/fails", status: 500, durationMs: 0, completed: true })
    for (const secret of secrets) assert.equal(`${text}${JSON.stringify(s.events)}${JSON.stringify(s.printed)}`.includes(secret), false)
  } finally { await s.close() }
})

test("JSON mal formado con contraseña responde 400 sin registrar el cuerpo", async () => {
  const s = await serve(Router())
  try {
    const response = await fetch(`${s.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: `{"email":"${secrets[3]}","password":"${secrets[0]}"` })
    assert.equal(response.status, 400)
    const text = await response.text()
    // Sin ruta resuelta (cuerpo inválido, 404 o límite por IP) no hay plantilla: nunca la URL.
    assert.deepEqual(s.events.map(event => [event.event, event.operation, event.status]), [["request", "POST (sin ruta)", 400]])
    for (const secret of secrets) assert.equal(`${text}${JSON.stringify(s.events)}${JSON.stringify(s.printed)}`.includes(secret), false)
  } finally { await s.close() }
})

test("un fallo después de enviar cabeceras corta la respuesta sin pasar el stack al manejador de Express", async () => {
  const router = Router()
  router.get("/stream", (_req, res) => {
    res.status(200).write("parcial")
    throw Object.assign(new Error(`invalid input syntax for type uuid: "${secrets[2]}"`), { code: "22P02" })
  })
  const s = await serve(router)
  try {
    await assert.rejects(async () => { await (await fetch(`${s.base}/stream`)).text() })
    assert.deepEqual(s.events.map(event => [event.event, event.requestId === s.events[0]?.requestId, event.completed ?? null]),
      [["request_failed", true, null], ["request", true, false]])
    assert.deepEqual(s.printed, [])
  } finally { await s.close() }
})

test("K036: una solicitud cortada antes de responder se registra sin estado", async () => {
  const router = Router()
  router.get("/slow", (_req, res) => { setTimeout(() => { if (!res.destroyed) res.json({}) }, 300) })
  const s = await serve(router)
  try {
    await assert.rejects(fetch(`${s.base}/slow`, { signal: AbortSignal.timeout(50) }))
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepEqual(s.events.map(event => [event.event, event.operation, event.status, event.completed]),
      [["request", "GET /slow", null, false]])
  } finally { await s.close() }
})
