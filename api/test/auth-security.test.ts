import test from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { createCsrfTokens } from "../src/infrastructure/crypto/csrf.js"
import { createTrafficLimits, TrafficLimitError } from "../src/http/rate-limits.js"
import { readAuthConfiguration } from "../src/composition.js"
import { blockAfterFailure, expiredFailuresCutoff, FAILURE_WINDOW_MS, retryAfterSeconds } from "../src/domain/attempts.js"

test("CSRF: firma, expiración, vínculo y rotación de clave", () => {
  const tokens = createCsrfTokens(randomBytes(32))
  const now = Date.now(), expiry = now + 1000
  const token = tokens.issue("anonymous", expiry)
  assert.equal(tokens.valid(token, "anonymous", now, expiry), true)
  assert.equal(tokens.valid(token, "session:1", now, expiry), false)
  assert.equal(tokens.valid(token, "anonymous", expiry, expiry), false)
  assert.equal(tokens.valid(token, "anonymous", now, expiry - 1), false)
  assert.equal(tokens.valid(token.replace(String(expiry), String(expiry + 1)), "anonymous", now, expiry + 1), false)
  assert.equal(createCsrfTokens(randomBytes(32)).valid(token, "anonymous", now, expiry), false)
})

test("límites generales y login IP: ráfaga, recarga y ventana móvil", () => {
  let time = Date.now()
  const limits = createTrafficLimits(() => time)
  for (let i = 0; i < 20; i++) limits.user("1")
  assert.throws(() => limits.user("1"), TrafficLimitError)
  time += 500; limits.user("1")
  for (let i = 0; i < 100; i++) limits.ip("ip")
  assert.throws(() => limits.ip("ip"), TrafficLimitError)
  for (let i = 0; i < 30; i++) limits.login("ip")
  assert.throws(() => limits.login("ip"), TrafficLimitError)
  time += 900000; limits.login("ip")
})

test("K034: revisión de códigos por IP en ventana de un minuto y mensajes con ráfaga 3", () => {
  let time = Date.now()
  const limits = createTrafficLimits(() => time)
  for (let i = 0; i < 30; i++) limits.pickupCode("ip")
  assert.throws(() => limits.pickupCode("ip"), (error: unknown) => error instanceof TrafficLimitError && error.retryAfter === 60)
  limits.pickupCode("otra ip")
  // Login y códigos usan ventanas separadas aunque compartan la IP.
  limits.login("ip")
  time += 59_999
  assert.throws(() => limits.pickupCode("ip"), TrafficLimitError)
  time += 1; limits.pickupCode("ip")
  for (let i = 0; i < 3; i++) limits.message("1")
  assert.throws(() => limits.message("1"), (error: unknown) => error instanceof TrafficLimitError && error.retryAfter === 5)
  limits.message("2")
  time += 5000; limits.message("1")
  assert.throws(() => limits.message("1"), TrafficLimitError)
})

test("K034: cinco fallos dentro de 15 minutos bloquean 15 minutos; el límite de la ventana es exclusivo", () => {
  const at = new Date("2030-01-01T00:15:00Z")
  const minutes = (n: number) => new Date(at.getTime() - n * 60_000)
  assert.equal(expiredFailuresCutoff(at).getTime(), at.getTime() - FAILURE_WINDOW_MS)
  assert.equal(blockAfterFailure([minutes(14), minutes(10), minutes(5)], at), null)
  assert.equal(blockAfterFailure([minutes(14), minutes(10), minutes(5), minutes(1)], at)?.getTime(), at.getTime() + FAILURE_WINDOW_MS)
  // Un fallo de hace exactamente 15 minutos ya salió de la ventana; uno futuro no cuenta.
  assert.equal(blockAfterFailure([minutes(15), minutes(10), minutes(5), minutes(1)], at), null)
  assert.equal(blockAfterFailure([minutes(10), minutes(5), minutes(1), minutes(-1)], at), null)
  assert.equal(retryAfterSeconds(null, at), 0)
  assert.equal(retryAfterSeconds(at, at), 0)
  assert.equal(retryAfterSeconds(new Date(at.getTime() + 1), at), 1)
  assert.equal(retryAfterSeconds(new Date(at.getTime() + FAILURE_WINDOW_MS), at), 900)
})

test("configuración falla cerrada: origen exacto HTTPS y secreto explícito", () => {
  const key = randomBytes(32).toString("base64")
  for (const origin of ["*", "null", "https://example.com/", "http://example.com", "https://example.com/path"]) {
    assert.throws(() => readAuthConfiguration({ RESCATE_ALLOWED_ORIGINS: origin, CSRF_SIGNING_KEY: key }))
  }
  assert.throws(() => readAuthConfiguration({ RESCATE_ALLOWED_ORIGINS: "https://example.com" }))
  assert.equal(readAuthConfiguration({ RESCATE_ALLOWED_ORIGINS: "https://example.com", CSRF_SIGNING_KEY: key }).origins.size, 1)
})
