import test from "node:test"
import assert from "node:assert/strict"
import { createIdentityUseCases } from "../src/application/identity/use-cases.js"
import { IdentityError } from "../src/application/identity/errors.js"
import { LOGIN_WINDOW_MS } from "../src/domain/identity.js"
import type { IdentityDependencies } from "../src/application/identity/use-cases.js"
import type { LoginSecurityState, LoginSecurityWriter, StoredSession } from "../src/application/identity/ports.js"

function fixture() {
  let time = Date.parse("2030-01-01T00:00:00Z")
  let verifies = 0
  let locked = false
  const state: LoginSecurityState = { blockedUntil: null, failureTimes: [] }
  const user = { id: "1", publicId: "public", email: "ana@example.com" }
  const credential = { hash: new Uint8Array(64), salt: new Uint8Array(16), parameters: { N: 65536, r: 8, p: 2 } }
  const sessions: StoredSession[] = []
  const writer: LoginSecurityWriter = {
    async deleteFailuresThrough(cutoff) { state.failureTimes = state.failureTimes.filter(at => at > cutoff) },
    async recordFailure(at) { state.failureTimes.push(at) },
    async setBlockedUntil(at) { state.blockedUntil = at },
    async createSession(input) { const session = { ...input, userId: user.id, id: String(sessions.length + 1), revokedAt: null }; sessions.push(session); return session },
    async revokeSession() { return true }, async revokePresentedSession() {},
  }
  const dependencies: IdentityDependencies = {
    identities: { async findByEmail(email) { return email === user.email ? { user, credential } : null },
      async findUserById() { return user }, async listEstablishments() { return [] },
      async createUserWithCredential() { return { kind: "created", user } } },
    canonicalizer: { async canonicalize(s) { return s.trim().toLowerCase() } }, // Doble; SQL Unicode se prueba en PostgreSQL.
    passwords: { async hash() { return credential }, async verify(password) { assert.equal(locked, false); verifies++; return password === "contraseña correcta" } },
    tokens: { issue() { return { secret: "opaque", tokenHash: new Uint8Array(32) } }, fingerprint() { return new Uint8Array(32) } },
    sessions: { async create(input) { return writer.createSession(input) }, async findByTokenHash() { return sessions.at(-1) ?? null }, async revoke() { return true } },
    security: { async read() { return state }, async withAccountLock(_id, operate) { locked = true; try { return await operate(state, writer) } finally { locked = false } } },
    dummyCredential: credential, now: () => new Date(time),
  }
  return { useCases: createIdentityUseCases(dependencies), dependencies, state, sessions, verifies: () => verifies, advance: (ms: number) => { time += ms } }
}
const rejected = (code: string) => (error: unknown) => error instanceof IdentityError && error.code === code

test("ventana móvil: éxito conserva fallos; quinto 401, bloqueo fijo y sesiones previas vigentes", async () => {
  const f = fixture()
  for (let n = 0; n < 4; n++) await assert.rejects(f.useCases.login("ana@example.com", "incorrecta larga"), rejected("invalid_credentials"))
  const success = await f.useCases.login("ana@example.com", "contraseña correcta")
  assert.equal(f.state.failureTimes.length, 4)
  await assert.rejects(f.useCases.login("ana@example.com", "incorrecta larga"), rejected("invalid_credentials"))
  const until = f.state.blockedUntil!.getTime()
  const calls = f.verifies()
  f.advance(1000)
  await assert.rejects(f.useCases.login("ana@example.com", "contraseña correcta"), rejected("login_blocked"))
  assert.equal(f.verifies(), calls); assert.equal(f.state.failureTimes.length, 5); assert.equal(f.state.blockedUntil!.getTime(), until)
  assert.equal((await f.useCases.resolveSession(success.secret))?.session.id, success.context.session.id)
  f.advance(LOGIN_WINDOW_MS - 1000)
  await f.useCases.login("ana@example.com", "contraseña correcta")
  assert.equal(f.state.failureTimes.length, 0); assert.equal(f.state.blockedUntil, null)
})

test("no usa ventana fija: elimina exactamente el límite y conserva los eventos posteriores", async () => {
  const f = fixture()
  await assert.rejects(f.useCases.login("ana@example.com", "incorrecta larga"))
  f.advance(LOGIN_WINDOW_MS / 2)
  await assert.rejects(f.useCases.login("ana@example.com", "incorrecta larga"))
  f.advance(LOGIN_WINDOW_MS / 2)
  await f.useCases.login("ana@example.com", "contraseña correcta")
  assert.equal(f.state.failureTimes.length, 1)
})

test("scrypt sin lock; si otro intento bloqueó mientras verificaba, no crea sesión", async () => {
  const f = fixture()
  let finish!: (valid: boolean) => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  f.dependencies.passwords.verify = async () => { entered(); return new Promise(resolve => { finish = resolve }) }
  const pending = f.useCases.login("ana@example.com", "contraseña correcta")
  await waiting
  f.state.blockedUntil = new Date(f.dependencies.now().getTime() + LOGIN_WINDOW_MS)
  finish(true)
  await assert.rejects(pending, rejected("login_blocked"))
  assert.equal(f.sessions.length, 0)
})

test("cuenta inexistente consume verificación y falla igual; contraseña Unicode por caracteres", async () => {
  const f = fixture()
  await assert.rejects(f.useCases.login("missing@example.com", "contraseña correcta"), rejected("invalid_credentials"))
  assert.equal(f.verifies(), 1)
  await assert.rejects(f.useCases.register("ana@example.com", "😀".repeat(6)), rejected("invalid_input"))
  await f.useCases.register(" Ana@Example.com ", "😀".repeat(12))
  assert.equal(f.sessions.length, 0)
})

test("expiración absoluta, revocación e indisponibilidad no se confunden con visitante", async () => {
  const f = fixture()
  const result = await f.useCases.login("ana@example.com", "contraseña correcta")
  f.advance(43200000)
  assert.equal(await f.useCases.resolveSession(result.secret), null)
  await assert.rejects(f.useCases.logout(result.context), rejected("no_session"))
  f.dependencies.sessions.findByTokenHash = async () => { throw new Error("database unavailable") }
  await assert.rejects(f.useCases.resolveSession(result.secret), /unavailable/)
})
