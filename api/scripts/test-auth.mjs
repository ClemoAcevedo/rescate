// Recorrido real K008 → Actor → K010, PostgreSQL aislado y Chromium HTTPS.
import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { request as httpsRequest } from 'node:https'
import pg from 'pg'
import { chromium } from 'playwright'
import { createIdentityUseCases } from '../dist/application/identity/use-cases.js'
import { createEmailCanonicalizer, createIdentityRepository } from '../dist/infrastructure/postgres/identity-repository.js'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createSessionRepository } from '../dist/infrastructure/postgres/session-repository.js'
import { createLoginSecurityRepository } from '../dist/infrastructure/postgres/login-security-repository.js'
import { createSessionCredentials } from '../dist/infrastructure/crypto/session-credentials.js'
import { createPasswordHasher, createDummyCredential } from '../dist/infrastructure/crypto/passwords.js'
import { assertContract } from '../test/support/openapi.ts'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString, 'Se requiere base dedicada')
const db = new pg.Client({ connectionString })
const dir = await mkdtemp(join(tmpdir(), 'rescate-k008-https-'))
let child, browser, port
let count = 0
const ok = label => console.log(`OK ${++count}: ${label}`)
const key = randomBytes(32).toString('base64')
const password = 'Contraseña ficticia K008 segura'
const secretName = '__Host-rescate_session', csrfName = '__Host-rescate_csrf'
const certPath = join(dir, 'cert.pem'), keyPath = join(dir, 'key.pem')
let cert
async function start() {
  child = fork(new URL('./test-auth-server.mjs', import.meta.url), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, CSRF_SIGNING_KEY: key, TEST_CERT: certPath, TEST_KEY: keyPath, TEST_PORT: String(port ?? 0) } })
  const [message] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('API de prueba terminó antes de escuchar') })])
  port = message.port
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; child = undefined
}
function client() {
  const jar = new Map()
  let csrf
  return {
    jar, get csrf() { return csrf },
    async call(method, path, body, overrides = {}) {
      const headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(method === 'GET' ? {} : { origin: `https://localhost:${port}`, 'x-csrf-token': csrf ?? '' }), ...overrides }
      for (const [name, value] of Object.entries(headers)) if (value === undefined) delete headers[name]
      const result = await new Promise((resolve, reject) => {
        const req = httpsRequest(`https://localhost:${port}${path}`, { method, headers, ca: cert }, res => {
          const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode,
            headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
        })
        req.on('error', reject)
        req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
      })
      for (const cookie of result.headers['set-cookie'] ?? []) {
        const [pair] = cookie.split(';'), at = pair.indexOf('=')
        if (cookie.includes('Max-Age=0;')) jar.delete(pair.slice(0, at))
        else jar.set(pair.slice(0, at), pair.slice(at + 1))
      }
      const parsed = result.text ? JSON.parse(result.text) : undefined
      if (parsed?.csrfToken) csrf = parsed.csrfToken
      const response = new Response(result.status === 204 ? null : result.text, { status: result.status,
        headers: Object.fromEntries(Object.entries(result.headers).filter(([,v]) => typeof v === 'string')) })
      assertContract(method, path, response, parsed)
      return { ...result, body: parsed }
    },
  }
}
try {
  await db.connect()
  assert.match((await db.query('SELECT current_database() AS name')).rows[0].name, /^rescate_k008_test_[a-z0-9_]+$/)
  const tables = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")
  assert.equal(tables.rowCount, 0, 'Solo una base nueva y vacía')
  execFileSync(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up'], { stdio: 'inherit' })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
  cert = await readFile(certPath)
  await start()
  const ana = client()
  const bootstrap = await ana.call('GET', '/auth/session')
  assert.equal(bootstrap.body.session, null)
  const anonymous = ana.csrf
  assert.equal((await ana.call('GET', '/auth/session')).body.csrfToken, anonymous)
  for (const origin of [undefined, 'null', 'https://evil.invalid', `https://localhost:${port}/`]) {
    assert.equal((await ana.call('POST', '/auth/register', { email: 'Ana@Example.com', password }, { origin })).status, 403)
  }
  assert.equal((await ana.call('POST', '/auth/register', { email: 'Ana@Example.com', password }, { 'x-csrf-token': 'forged' })).status, 403)
  assert.equal((await ana.call('POST', '/auth/register', { email: 'Ana@Example.com', password, role: 'admin' })).status, 422)
  assert.equal((await ana.call('POST', '/auth/register', { email: 'Ana@Example.com', password: '😀'.repeat(6) })).status, 422)
  assert.equal((await ana.call('POST', '/auth/register', '{')).status, 400)
  assert.equal((await ana.call('POST', '/auth/register', { email: 'Ana@Example.com', password: 'x'.repeat(17000) })).status, 413)
  assert.equal((await ana.call('POST', '/auth/register', '{}', { 'content-type': 'text/plain' })).status, 415)
  const registered = await ana.call('POST', '/auth/register', { email: '\u00a0Ana@Example.com\ufeff', password })
  assert.equal(registered.status, 201); assert.equal(registered.body.user.email, 'ana@example.com')
  assert.match(registered.body.user.id, /^[0-9a-f-]{36}$/)
  assert.equal(ana.jar.has(secretName), false)
  assert.equal((await db.query('SELECT * FROM memberships')).rowCount, 0)
  assert.equal((await db.query('SELECT * FROM sessions')).rowCount, 0)
  assert.equal((await ana.call('POST', '/auth/register', { email: 'ANA@example.com', password })).status, 409)
  ok('bootstrap, origen/CSRF, DTO y registro canónico sin sesión ni membership; respuestas OpenAPI')

  const bad = await ana.call('POST', '/auth/login', { email: 'ana@example.com', password: 'incorrecta suficientemente larga' })
  const missing = await ana.call('POST', '/auth/login', { email: 'missing@example.com', password })
  assert.equal(bad.status, 401); assert.deepEqual(bad.body, missing.body)
  const logged = await ana.call('POST', '/auth/login', { email: ' Ana@Example.com ', password })
  assert.equal(logged.status, 200); assert.deepEqual(logged.body.session.operableEstablishments, [])
  assert.notEqual(ana.csrf, anonymous)
  assert.equal(logged.headers['set-cookie'].length, 2)
  for (const cookie of logged.headers['set-cookie']) {
    for (const attr of ['Path=/', 'Max-Age=43200', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(cookie.includes(attr))
    assert.equal(cookie.includes('Domain='), false)
  }
  const firstSecret = ana.jar.get(secretName)
  assert.equal(JSON.stringify(logged.body).includes(firstSecret), false)
  const row = (await db.query('SELECT * FROM sessions')).rows[0]
  assert.equal(row.token_hash.length, 32); assert.equal(row.token, undefined)
  assert.equal(row.expires_at - row.created_at, 43200000)
  await stop(); await start()
  assert.deepEqual((await ana.call('GET', '/auth/session')).body.session, logged.body.session)
  assert.equal((await ana.call('GET', '/auth/session')).body.csrfToken, logged.body.csrfToken)
  ok('scrypt, cookies independientes, hash exclusivo en PostgreSQL y sesión/CSRF tras reiniciar proceso API')

  const estate = (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('Establecimiento ficticio','Dirección ficticia',-33.45,-70.66,'America/Santiago') RETURNING id,public_id`)).rows[0]
  const anaId = (await db.query("SELECT id FROM users WHERE email='ana@example.com'")).rows[0].id
  const lotInput = { description: 'Pack ficticio', category: 'Verduras', quantity: 2, address: 'Dirección ficticia',
    latitude: -33.45, longitude: -70.66, timeZone: 'America/Santiago',
    pickupStartsAt: new Date(Date.now() + 3600000).toISOString(), pickupEndsAt: new Date(Date.now() + 7200000).toISOString() }
  const path = `/establishments/${estate.public_id}/lots`
  assert.equal((await ana.call('POST', path, lotInput)).status, 403)
  await db.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)', [anaId, estate.id])
  assert.deepEqual((await ana.call('GET', '/auth/session')).body.session.operableEstablishments, [{ id: estate.public_id, name: 'Establecimiento ficticio' }])
  assert.equal((await ana.call('POST', path, lotInput, { 'x-csrf-token': anonymous })).status, 403)
  const lot = await ana.call('POST', path, lotInput); assert.equal(lot.status, 201)
  const lotPath = `/lots/${lot.body.id}`
  assert.equal((await ana.call('GET', lotPath)).status, 200)
  assert.equal((await ana.call('PATCH', lotPath, { version: 1, quantity: 3 })).status, 200)
  assert.equal((await ana.call('PATCH', lotPath, { version: 1, quantity: 4 })).status, 409)
  await db.query('DELETE FROM memberships WHERE user_id=$1', [anaId]) // Revocación deliberada de fixture, no limpieza migratoria.
  assert.equal((await ana.call('POST', `${lotPath}/publish`, { version: 2 })).status, 403)
  assert.equal((await ana.call('GET', lotPath)).status, 403)
  await db.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)', [anaId, estate.id])
  assert.equal((await ana.call('POST', `${lotPath}/publish`, { version: 2 })).status, 200)
  const attacker = client()
  assert.equal((await attacker.call('GET', lotPath, undefined, { 'x-rescate-dev-actor': String(anaId) })).status, 401)
  ok('sesión → Actor → K010: membership actual, creación/edición/publicación y ausencia de bypass por cabecera')

  const independent = client(); await independent.call('GET', '/auth/session')
  assert.equal((await independent.call('POST', '/auth/login', { email: 'ana@example.com', password })).status, 200)
  const previous = ana.jar.get(secretName)
  assert.equal((await ana.call('POST', '/auth/login', { email: 'ana@example.com', password })).status, 200)
  assert.notEqual(ana.jar.get(secretName), previous)
  const stolenOld = client(); stolenOld.jar.set(secretName, previous)
  assert.equal((await stolenOld.call('GET', '/auth/session')).body.session, null)
  assert.equal((await ana.call('POST', '/auth/logout')).status, 204)
  assert.equal(ana.jar.size, 0)
  assert.equal((await ana.call('POST', '/auth/logout')).status, 401)
  assert.ok((await independent.call('GET', '/auth/session')).body.session)
  ok('rotación revoca sesión presentada; logout elimina cookies y revoca solo la sesión actual')

  // Persistencia del quinto fallo. Ya hay un fallo anterior a los logins exitosos.
  const attempt = client(); await attempt.call('GET', '/auth/session')
  for (let n = 0; n < 4; n++) assert.equal((await attempt.call('POST', '/auth/login', { email: 'ana@example.com', password: 'incorrecta suficientemente larga' })).status, 401)
  const before = (await db.query('SELECT blocked_until FROM login_security_state WHERE user_id=$1', [anaId])).rows[0].blocked_until
  assert.ok(before > new Date())
  await stop(); await start()
  const blocked = await attempt.call('POST', '/auth/login', { email: 'ana@example.com', password })
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers['retry-after']) > 0)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM login_failures WHERE user_id=$1', [anaId])).rows[0].n, 5)
  assert.equal((await db.query('SELECT blocked_until FROM login_security_state WHERE user_id=$1', [anaId])).rows[0].blocked_until.getTime(), before.getTime())
  assert.ok((await independent.call('GET', '/auth/session')).body.session)
  ok('fallos sobreviven éxitos y reinicio; quinto 401, posterior 429 sin extender bloqueo ni revocar sesiones')

  // Expiración real de fixture conserva CHECK de 12 h.
  await db.query('UPDATE sessions SET created_at=created_at-interval \'13 hours\', expires_at=expires_at-interval \'13 hours\' WHERE revoked_at IS NULL')
  assert.equal((await independent.call('GET', '/auth/session')).body.session, null)
  assert.equal((await independent.call('GET', lotPath)).status, 401)
  ok('expiración absoluta impide autenticar y operar lotes')

  const concurrentPool = createPool({ connectionString, max: 3 })
  try {
    const identities = createIdentityRepository(concurrentPool)
    const security = createLoginSecurityRepository(concurrentPool)
    const realPasswords = createPasswordHasher()
    const account = await identities.createUserWithCredential('concurrent@example.com', await realPasswords.hash(password))
    assert.equal(account.kind, 'created')
    let started, release
    const verifying = new Promise(resolve => { started = resolve })
    const dependencies = { identities, security, canonicalizer: createEmailCanonicalizer(concurrentPool),
      sessions: createSessionRepository(concurrentPool), tokens: createSessionCredentials(), dummyCredential: createDummyCredential(),
      now: () => new Date(), passwords: { hash: realPasswords.hash, async verify(value) {
        if (value === password) { started(); return new Promise(resolve => { release = resolve }) }
        return false
      } } }
    const useCases = createIdentityUseCases(dependencies)
    const pendingSuccess = useCases.login('concurrent@example.com', password)
    await verifying
    // Verificador controlado: la concurrencia y las transacciones son PostgreSQL reales.
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => useCases.login('concurrent@example.com', 'incorrecta larga')))
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'invalid_credentials'))
    release(true)
    await assert.rejects(pendingSuccess, error => error.code === 'login_blocked')
    assert.equal((await db.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [account.user.id])).rows[0].n, 0)
    assert.equal((await security.read(account.user.id)).failureTimes.length, 5)
    ok('concurrencia real en PostgreSQL: cinco fallos serializados impiden confirmar verificación correcta anterior')
  } finally { await concurrentPool.end() }

  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  await page.goto(`https://localhost:${port}/`)
  const browserResult = await page.evaluate(async ({ password, lotPath }) => {
    const request = async (path, data, token) => {
      const res = await fetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(data) } : {})
      return { status: res.status, body: await res.json() }
    }
    const bootstrap = await request('/auth/session')
    const register = await request('/auth/register', { email: 'browser@example.com', password }, bootstrap.body.csrfToken)
    const login = await request('/auth/login', { email: 'browser@example.com', password }, bootstrap.body.csrfToken)
    const session = await request('/auth/session')
    return { statuses: [register.status, login.status, session.status], login: login.body, session: session.body, visibleCookies: document.cookie, foreignLotStatus: (await fetch(lotPath)).status }
  }, { password, lotPath })
  assert.equal(browserResult.foreignLotStatus, 403)
  assert.deepEqual(browserResult.statuses, [201, 200, 200]); assert.equal(browserResult.visibleCookies, '')
  assert.equal(browserResult.session.session.user.email, 'browser@example.com')
  assert.equal(browserResult.session.csrfToken, browserResult.login.csrfToken)
  const cookies = await context.cookies()
  assert.equal(cookies.length, 2)
  for (const cookie of cookies) { assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true); assert.equal(cookie.sameSite, 'Lax'); assert.equal(cookie.path, '/') }
  const logoutStatus = await page.evaluate(async token => (await fetch('/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': token } })).status, browserResult.session.csrfToken)
  assert.equal(logoutStatus, 204); assert.equal((await context.cookies()).length, 0)
  await context.close()
  ok('Chromium HTTPS real: navegador conserva/envía cookies Secure+HttpOnly, sesión y logout sin cookie accesible a JS')
  const databaseName = (await db.query('SELECT current_database() name')).rows[0].name
  // PostgreSQL exige ALTER ALLOW_CONNECTIONS desde otra base; no se modifican
  // tablas de postgres ni de desarrollo, solo se cierra la base dedicada validada.
  const maintenanceUrl = new URL(connectionString); maintenanceUrl.pathname = '/postgres'
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href })
  await maintenance.connect()
  try {
    const fixturePid = (await db.query('SELECT pg_backend_pid() pid')).rows[0].pid
    await maintenance.query(`ALTER DATABASE "${databaseName}" ALLOW_CONNECTIONS false`)
    await maintenance.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>$2', [databaseName, fixturePid])
    assert.equal((await independent.call('GET', '/auth/session')).status, 503)
  } finally {
    try { await maintenance.query(`ALTER DATABASE "${databaseName}" ALLOW_CONNECTIONS true`) }
    finally { await maintenance.end() }
  }
  assert.equal((await independent.call('GET', '/auth/session')).body.session, null)
  ok('pérdida de conexiones y base indisponible: API sigue viva, responde 503 y se recupera sin reiniciar')
  console.log(`PASS K008 funcional: ${count} grupos; respuestas del cliente HTTPS comprobadas contra OpenAPI.`)
} finally {
  await browser?.close(); await stop(); await db.end(); await rm(dir, { recursive: true, force: true })
}
