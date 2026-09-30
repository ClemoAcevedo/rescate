// K008 etapa 2: adaptadores contra PostgreSQL real. Sin HTTP ni casos de uso.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createEmailCanonicalizer, createIdentityRepository } from '../dist/infrastructure/postgres/identity-repository.js'
import { createSessionRepository } from '../dist/infrastructure/postgres/session-repository.js'
import { createLoginSecurityRepository } from '../dist/infrastructure/postgres/login-security-repository.js'
import { createPasswordHasher } from '../dist/infrastructure/crypto/passwords.js'
import { createSessionCredentials } from '../dist/infrastructure/crypto/session-credentials.js'

assert.ok(process.env.DATABASE_URL, 'Configura DATABASE_URL para una base vacía dedicada')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
let pool = createPool({ connectionString: process.env.DATABASE_URL, max: 2 })
const query = async (sql, values) => (await client.query(sql, values)).rows
let checks = 0
const ok = message => console.log(`OK ${++checks}: ${message}`)
const instant = new Date('2030-01-01T10:00:00Z')
const expiresAt = new Date('2030-01-01T22:00:00Z')
const secrets = createSessionCredentials()
const newSession = () => ({ tokenHash: secrets.issue().tokenHash, createdAt: instant, expiresAt })

async function waitForAccountWaiter() {
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {
    const rows = await query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%public.login_security_state%'`)
    if (rows.length) return
    await delay(10)
  }
  throw new Error('No se observó el segundo adaptador esperando el lock de la cuenta')
}

try {
  await client.connect()
  const [server] = await query("SELECT current_database() AS name, current_setting('server_version') AS version")
  assert.match(server.name, /^rescate_k008_test_[a-z0-9_]+$/, 'Solo bases dedicadas rescate_k008_test_*')
  const existing = await query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','S','f')`)
  assert.deepEqual(existing, [], 'La base debe comenzar vacía')
  execFileSync(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up'],
    { stdio: 'inherit', env: process.env })
  const identities = createIdentityRepository(pool)
  const canonicalizer = createEmailCanonicalizer(pool)
  const login = createLoginSecurityRepository(pool)
  const sessions = createSessionRepository(pool)
  const passwords = createPasswordHasher()

  for (const input of ['\u00a0İ.PÉREZ+Tag@EXAMPLE.COM\ufeff', 'ΟΣ@EXAMPLE.COM', ' E\u0301@EXAMPLE.COM ']) {
    const canonical = await canonicalizer.canonicalize(input)
    assert.equal(canonical, (await query('SELECT public.canonicalize_email($1) AS email', [input]))[0].email)
    await query('INSERT INTO users(email) VALUES ($1)', [canonical]) // Pasa el mismo CHECK.
    const account = await identities.findByEmail(canonical)
    assert.equal(account.credential, null)
    assert.equal(typeof account.user.id, 'string')
  }
  assert.equal(await identities.findByEmail('inexistente@example.invalid'), null)
  ok('canonicalización delegada a SQL y lectura de cuentas sin credencial')

  const credential = await passwords.hash('Contraseña exclusivamente de fixture K008')
  await assert.rejects(identities.createUserWithCredential('atomic@example.invalid', {
    ...credential, hash: credential.hash.slice(0, 63),
  }), error => error.code === '23514')
  assert.equal(await identities.findByEmail('atomic@example.invalid'), null, 'falló segunda escritura: no queda usuario huérfano')
  const races = await Promise.all([
    identities.createUserWithCredential('atomic@example.invalid', credential),
    identities.createUserWithCredential('atomic@example.invalid', credential),
  ])
  assert.deepEqual(races.map(result => result.kind).sort(), ['created', 'email_exists'])
  const user = races.find(result => result.kind === 'created').user
  const otherResult = await identities.createUserWithCredential('other@example.invalid', credential)
  assert.equal(otherResult.kind, 'created')
  const other = otherResult.user
  const account = await identities.findByEmail(user.email)
  assert.deepEqual(account.credential, credential)
  assert.equal(await passwords.verify('Contraseña exclusivamente de fixture K008', account.credential), true)
  assert.deepEqual(await identities.findUserById(user.id), user)
  assert.equal(await identities.findUserById('-1'), null)
  assert.equal((await query('SELECT count(*)::int AS n FROM user_credentials WHERE user_id=$1', [user.id]))[0].n, 1)
  assert.deepEqual(await query('SELECT * FROM memberships WHERE user_id=$1', [user.id]), [])
  assert.deepEqual(await query('SELECT * FROM sessions WHERE user_id=$1', [user.id]), [])
  ok('usuario+credencial atómicos, rollback SQL y registro concurrente sin duplicados; sin sesión/membership automática')

  const issued = secrets.issue()
  const transmitted = []
  // Observa los parámetros sin reemplazar PostgreSQL: todas las queries se ejecutan.
  const observedSessions = createSessionRepository({
    query(sql, values) { transmitted.push(...values); return pool.query(sql, values) },
  })
  const stored = await observedSessions.create({ userId: user.id, tokenHash: issued.tokenHash, createdAt: instant, expiresAt })
  assert.equal(transmitted.includes(issued.secret), false)
  const bytesSent = transmitted.filter(value => Buffer.isBuffer(value))
  assert.deepEqual(bytesSent, [Buffer.from(issued.tokenHash)])
  assert.notDeepEqual(bytesSent[0], Buffer.from(issued.secret, 'base64url'))
  assert.deepEqual(await sessions.findByTokenHash(secrets.fingerprint(issued.secret)), stored)
  assert.equal(await sessions.findByTokenHash(secrets.issue().tokenHash), null)
  const otherSession = await sessions.create({ userId: other.id, ...newSession() })
  const revokedAt = new Date('2030-01-01T10:01:00Z')
  const revocations = await Promise.all([sessions.revoke(stored.id, revokedAt), sessions.revoke(stored.id, revokedAt)])
  assert.deepEqual(revocations.sort(), [false, true])
  assert.deepEqual((await sessions.findByTokenHash(issued.tokenHash)).revokedAt, revokedAt)
  assert.equal(await sessions.revoke(stored.id, new Date('2030-01-01T11:00:00Z')), false)
  assert.deepEqual((await sessions.findByTokenHash(issued.tokenHash)).revokedAt, revokedAt)
  ok('PostgreSQL recibe solo huella; búsqueda y revocación condicional preservan datos de la sesión')

  // Carrera de inicialización: una cuenta todavía sin fila de estado.
  assert.equal(await login.read(user.id), null)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const blockedUntil = new Date('2030-01-01T10:15:00Z')
  let secondEntered = false
  const first = login.withAccountLock(user.id, async (state, writer) => {
    assert.deepEqual(state, { blockedUntil: null, failureTimes: [] })
    await writer.recordFailure(instant)
    await writer.setBlockedUntil(blockedUntil) // Dato elegido por el consumidor de prueba.
    entered.resolve()
    await release.promise
  })
  let second
  try {
    await entered.promise
    second = login.withAccountLock(user.id, async state => {
      secondEntered = true
      assert.deepEqual(state, { blockedUntil, failureTimes: [instant] }, 'relee lo confirmado por el primer escritor')
      // El consumidor decide no escribir; el adaptador no crea una sesión.
    })
    // Atender un posible rechazo inmediatamente, sin ocultarlo al await posterior.
    second.catch(() => {})
    await waitForAccountWaiter()
    assert.equal(secondEntered, false)
  } finally {
    release.resolve()
    await Promise.all([first, second])
  }
  assert.deepEqual(await login.read(user.id), { blockedUntil, failureTimes: [instant] })
  assert.equal((await query('SELECT count(*)::int AS n FROM login_security_state WHERE user_id=$1', [user.id]))[0].n, 1)
  ok('inicialización concurrente serializada y relectura real después de esperar el lock')

  const before = await login.read(user.id)
  const rolledBack = newSession()
  await assert.rejects(login.withAccountLock(user.id, async (_state, writer) => {
    await writer.recordFailure(revokedAt)
    await writer.setBlockedUntil(null)
    await writer.createSession(rolledBack)
    throw new Error('fallo controlado del consumidor')
  }), /fallo controlado/)
  assert.deepEqual(await login.read(user.id), before)
  assert.equal(await sessions.findByTokenHash(rolledBack.tokenHash), null)
  const otherHash = (await query('SELECT token_hash FROM sessions WHERE id=$1', [otherSession.id]))[0].token_hash
  await assert.rejects(login.withAccountLock(other.id, async (_state, writer) => {
    await writer.recordFailure(instant)
    await writer.revokeSession(otherSession.id, revokedAt)
    await writer.createSession({ ...newSession(), tokenHash: issued.tokenHash }) // UNIQUE real.
  }), error => error.code === '23505')
  assert.equal(await login.read(other.id), null, 'también revierte la inicialización de estado')
  assert.equal((await sessions.findByTokenHash(otherHash)).revokedAt, null)
  ok('rollback de callback y de SQL revierte juntos fallos, bloqueo, creación y revocación de sesión')

  const exactCutoff = new Date('2030-01-01T09:45:00Z')
  const afterCutoff = new Date('2030-01-01T09:45:00.001Z')
  const committedInput = newSession()
  let committedSession
  await login.withAccountLock(other.id, async (_state, writer) => {
    await writer.recordFailure(new Date('2030-01-01T09:44:59Z'))
    await writer.recordFailure(exactCutoff)
    await writer.recordFailure(afterCutoff)
    await writer.deleteFailuresThrough(exactCutoff)
    assert.equal(await writer.revokeSession(stored.id, revokedAt), false, 'writer no revoca la sesión de otra cuenta')
    assert.equal(await writer.revokeSession(otherSession.id, revokedAt), true)
    committedSession = await writer.createSession(committedInput)
  })
  assert.deepEqual((await login.read(other.id)).failureTimes, [afterCutoff])
  assert.deepEqual(await sessions.findByTokenHash(committedInput.tokenHash), committedSession)
  assert.equal(committedSession.userId, other.id)
  assert.deepEqual((await sessions.findByTokenHash(otherHash)).revokedAt, revokedAt)
  // Lectura/no-op no elimina automáticamente eventos ni modifica un bloqueo.
  await login.withAccountLock(user.id, async () => {})
  assert.deepEqual(await login.read(user.id), before)
  ok('commit conjunto de eventos/sesión/revocación, corte inclusivo e aislamiento por cuenta sin reglas de login')

  await pool.end()
  pool = createPool({ connectionString: process.env.DATABASE_URL, max: 2 })
  assert.deepEqual(await createLoginSecurityRepository(pool).read(user.id), before)
  assert.deepEqual(await createSessionRepository(pool).findByTokenHash(issued.tokenHash), { ...stored, revokedAt })
  assert.deepEqual((await createIdentityRepository(pool).findByEmail(user.email)).credential, credential)
  ok('nuevos Pool/adaptadores recuperan credencial, sesión revocada, fallos y bloqueo desde PostgreSQL')
  console.log(`PASS K008 Infrastructure: ${checks} grupos sobre PostgreSQL ${server.version}; no acredita casos de uso ni HTTP`)
} finally {
  await client.end()
  await pool.end()
}
