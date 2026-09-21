import test from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { createCsrfTokens } from "../src/infrastructure/crypto/csrf.js"
import { createTrafficLimits, TrafficLimitError } from "../src/http/rate-limits.js"
import { readAuthConfiguration } from "../src/composition.js"

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

test("configuración falla cerrada: origen exacto HTTPS y secreto explícito", () => {
  const key = randomBytes(32).toString("base64")
  for (const origin of ["*", "null", "https://example.com/", "http://example.com", "https://example.com/path"]) {
    assert.throws(() => readAuthConfiguration({ RESCATE_ALLOWED_ORIGINS: origin, CSRF_SIGNING_KEY: key }))
  }
  assert.throws(() => readAuthConfiguration({ RESCATE_ALLOWED_ORIGINS: "https://example.com" }))
  assert.equal(readAuthConfiguration({ RESCATE_ALLOWED_ORIGINS: "https://example.com", CSRF_SIGNING_KEY: key }).origins.size, 1)
})
