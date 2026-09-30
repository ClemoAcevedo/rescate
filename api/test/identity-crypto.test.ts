import assert from "node:assert/strict"
import { createHash, scryptSync } from "node:crypto"
import test from "node:test"
import { InvalidPasswordCredentialError, PasswordHashingCapacityError } from "../src/application/identity/errors.js"
import { createPasswordHasher, SCRYPT_CREATION_PARAMETERS } from "../src/infrastructure/crypto/passwords.js"
import { createSessionCredentials } from "../src/infrastructure/crypto/session-credentials.js"

test("scrypt: sal aleatoria, bytes acordados y verificación sin normalizar la contraseña", async () => {
  const passwords = createPasswordHasher()
  const password = " Contraseña ficticia de prueba "
  const [first, second] = await Promise.all([passwords.hash(password), passwords.hash(password)])
  assert.equal(first.hash.length, 64)
  assert.equal(first.salt.length, 16)
  assert.deepEqual(first.parameters, SCRYPT_CREATION_PARAMETERS)
  assert.notDeepEqual(first.salt, second.salt)
  assert.notDeepEqual(first.hash, second.hash)
  assert.equal(await passwords.verify(password, first), true)
  assert.equal(await passwords.verify(password.trim(), first), false)
  assert.equal(await passwords.verify("Otra contraseña ficticia", first), false)
})

test("verify utiliza parámetros persistidos y rechaza credenciales malformadas/costos arbitrarios", async () => {
  const password = "Credencial de perfil anterior"
  const salt = Buffer.alloc(16, 7)
  const parameters = { N: 131072, r: 8, p: 1 }
  // Referencia nativa independiente del método hash del adaptador.
  const hash = scryptSync(password, salt, 64, { ...parameters, maxmem: 192 * 1024 * 1024 })
  const passwords = createPasswordHasher()
  assert.equal(await passwords.verify(password, { hash, salt, parameters }), true)
  await assert.rejects(passwords.verify(password, { hash, salt, parameters: { N: 2 ** 30, r: 8, p: 1 } }), InvalidPasswordCredentialError)
  await assert.rejects(passwords.verify(password, { hash: hash.subarray(0, 63), salt, parameters }), InvalidPasswordCredentialError)
  await assert.rejects(passwords.verify(password, { hash, salt: salt.subarray(0, 15), parameters }), InvalidPasswordCredentialError)
  assert.throws(() => createPasswordHasher({ N: 2, r: 8, p: 1 }), InvalidPasswordCredentialError)
})

test("scrypt limita simultaneidad sin cola y libera capacidad al terminar", async () => {
  const passwords = createPasswordHasher()
  const first = passwords.hash("Primer cálculo ficticio")
  const second = passwords.hash("Segundo cálculo ficticio")
  await assert.rejects(passwords.hash("Tercer cálculo ficticio"), PasswordHashingCapacityError)
  await Promise.all([first, second])
  const next = await passwords.hash("Cálculo posterior ficticio")
  assert.equal(await passwords.verify("Cálculo posterior ficticio", next), true)
})

test("sesión: secreto aleatorio, SHA-256 y rechazo de representaciones alternativas", () => {
  const credentials = createSessionCredentials()
  const first = credentials.issue()
  const second = credentials.issue()
  assert.notEqual(first.secret, second.secret)
  assert.notDeepEqual(first.tokenHash, second.tokenHash)
  assert.match(first.secret, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(first.tokenHash.length, 32)
  const bytes = Buffer.from(first.secret, "base64url")
  assert.deepEqual(Buffer.from(first.tokenHash), createHash("sha256").update(bytes).digest())
  assert.deepEqual(credentials.fingerprint(first.secret), first.tokenHash)
  const canonical = Buffer.alloc(32).toString("base64url")
  const alias = canonical.slice(0, -1) + "B" // Mismos bytes, bits de relleno no canónicos.
  assert.deepEqual(Buffer.from(alias, "base64url"), Buffer.from(canonical, "base64url"))
  for (const invalid of ["", " ", first.secret + "=", " " + first.secret, alias, "a".repeat(1000)]) {
    assert.equal(credentials.fingerprint(invalid), null)
  }
})
