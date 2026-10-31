// K039 · integridad de E3 contra PostgreSQL real: solo los casos de anexo H (p. 19 y p. 23) que
// faltaban o estaban bajo su escala. Las personas usan la API real por HTTP con sesiones
// sembradas por SQL y un ritmo bajo los límites por IP y por usuario de rate-limits.ts, así que
// un 429 de esos límites, un 5xx o un timeout es un resultado del sistema: se cuenta aparte como
// inesperado y no decide el caso. Los únicos rechazos buscados son los 409 sin stock u oferta
// vencida, el 429 del cupo de mensajes y los 403/404 del aislamiento. Hacen fallar su caso la
// integridad, una aserción o una respuesta fuera de OpenAPI. Se puede repetir sobre la misma
// base: el caso 4 espera a que el latido de un worker anterior quede viejo y el 6 deja que el
// worker vacíe lo pendiente antes de fijar el plazo. Cada caso queda, con el ambiente, en
// api/.k039-results/<base>/integrity.json.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { assertContract } from '../test/support/openapi.ts'
import { createApi } from '../dist/composition.js'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createPickupCodes } from '../dist/infrastructure/crypto/pickup-codes.js'
import { createDiscoveryRepository } from '../dist/infrastructure/postgres/discovery-repository.js'
import { createDiscoveryUseCases } from '../dist/application/discovery/use-cases.js'
import { createReservationRepository } from '../dist/infrastructure/postgres/reservation-repository.js'
import { createReservationUseCases } from '../dist/application/reservations/use-cases.js'
import { createWaitlistRepository } from '../dist/infrastructure/postgres/waitlist-repository.js'
import { createWaitlistUseCases } from '../dist/application/waitlist/use-cases.js'
import { createChatRepository } from '../dist/infrastructure/postgres/chat-repository.js'
import { createChatUseCases } from '../dist/application/chat/use-cases.js'
import { DUE_LOTS } from '../dist/infrastructure/postgres/expiry-repository.js'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_k039_test_/.test(new URL(connectionString).pathname.slice(1)),
  'Se requiere base de prueba aislada K039')
const databaseName = new URL(connectionString).pathname.slice(1)
const root = fileURLToPath(new URL('../../', import.meta.url))
const apiDirectory = fileURLToPath(new URL('../', import.meta.url))
const ORIGIN = 'https://localhost:5173'
const SESSION_COOKIE = '__Host-rescate_session'
// Mensajes de errors.ts: separan el 409 esperado (sin stock, oferta vencida) de cualquier otro 409.
const NO_STOCK = 'El lote cerró o no tiene packs suficientes.'
const OFFER_EXPIRED = 'La solicitud venció: la oferta o el lote ya no están vigentes.'
const EXPIRY_GOAL_MS = 30_000
// Sin un ciclo en este plazo la salud informa el worker detenido (operations.ts).
const WORKER_STALE_SECONDS = 60
// Cupo de mensajes de rate-limits.ts (12/min, ráfaga 3). Recién vaciado por la ráfaga, su
// Retry-After es 5 s; los cupos por IP y por usuario nunca pasan de 1 s, así que Retry-After ≥ 2
// identifica este cupo.
const MESSAGE_BURST = 3
const LATENCY_NOTE = 'Informativas, no evidencia de meta: generador y API comparten proceso y equipo; la meta de reserva '
  + 'se mide con k6. serverDurationMs agrupa el registro K036 por operación y estado (la preparación de sesiones queda '
  + 'en su propio grupo); clientLatencyMs agrupa por la etiqueta de statusCounts.'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(label, condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await condition()) return; await sleep(100) }
  assert.fail(`Tiempo agotado: ${label}`)
}

const startedAt = new Date()
const pickupKey = randomBytes(32)
// Registro K036 de la API: una línea por solicitud con estado y durationMs. Se guarda en memoria
// para no imprimir miles de líneas; los demás eventos (request_failed, etc.) se imprimen.
const requests = []
const api = createApi({ ...process.env, RESCATE_ALLOWED_ORIGINS: ORIGIN, CSRF_SIGNING_KEY: randomBytes(32).toString('base64'),
  PICKUP_CODE_KEY: pickupKey.toString('base64') }, event => {
  if (event.event === 'request') requests.push(event)
  else console.log(JSON.stringify(event))
})
const server = api.app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const database = new pg.Client({ connectionString })
// Fuera de cualquier transacción: pg_stat_activity se congela dentro de una.
const observer = new pg.Client({ connectionString })
// Retiene el bloqueo del lote en el caso del límite de la oferta.
const blocker = new pg.Client({ connectionString })
const pool = createPool({ connectionString })
const codes = createPickupCodes(pickupKey)
const discovery = createDiscoveryUseCases(createDiscoveryRepository(pool), codes, () => new Date())
const reservations = createReservationUseCases(createReservationRepository(pool), codes, () => new Date())
const waitlist = createWaitlistUseCases(createWaitlistRepository(pool), codes, () => new Date())
const chat = createChatUseCases(createChatRepository(pool), () => new Date())
// Respuestas que no cumplen OpenAPI: se cuentan como inesperadas y hacen fallar su caso.
const contractViolations = []

let worker = null
// Interrumpida la suite, el worker no queda huérfano.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => { worker?.child.kill('SIGKILL'); process.exit(code) })
}

/**
 * Cubeta local más estricta que la de la API por IP (3000/min, ráfaga 100): 35/s y ráfaga 80.
 * Una ráfaga de `count` solicitudes sale junta solo cuando hay saldo para todas, así que nunca
 * queda repartida en el tiempo. En el último pack cada persona escribe una vez por ráfaga: a lo
 * más 1,75 veces por segundo, bajo las 2 por segundo del límite de escrituras por usuario.
 */
function pacer(perSecond, burst) {
  let tokens = burst
  let at = performance.now()
  let turn = Promise.resolve()
  const refill = () => {
    const time = performance.now()
    tokens = Math.min(burst, tokens + (time - at) * perSecond / 1000)
    at = time
  }
  return (count = 1) => (turn = turn.then(async () => {
    refill()
    if (tokens < count) { await sleep(Math.ceil((count - tokens) * 1000 / perSecond)); refill() }
    tokens -= count
  }))
}
const pace = pacer(35, 80)

async function seedUser(label, establishmentId = null) {
  const { rows: [user] } = await database.query('INSERT INTO users(email) VALUES ($1) RETURNING id::text',
    [`k039-${label}-${randomUUID()}@example.invalid`])
  if (establishmentId) await database.query('INSERT INTO memberships (user_id, establishment_id) VALUES ($1, $2)', [user.id, establishmentId])
  return user.id
}

/**
 * Persona con sesión sembrada por SQL, como otro navegador: cookie y CSRF propios. Sin registro
 * ni login, que tienen su propio límite por IP. `prepaid` indica que la ráfaga ya pagó su saldo.
 */
async function person(label, establishmentId = null) {
  const userId = await seedUser(label, establishmentId)
  const secret = randomBytes(32)
  await database.query(`INSERT INTO sessions(user_id, token_hash, created_at, expires_at)
    VALUES ($1, $2, now(), now() + interval '12 hours')`, [userId, createHash('sha256').update(secret).digest()])
  const cookies = new Map([[SESSION_COOKIE, secret.toString('base64url')]])
  let csrf = ''
  async function call(method, path, body, { prepaid = false } = {}) {
    if (!prepaid) await pace()
    const started = performance.now()
    // Anexos H p. 20: el navegador espera hasta 10 s; p. 19: un timeout cuenta como fallo.
    const signal = AbortSignal.timeout(10_000)
    let response
    try {
      response = await fetch(`${base}${path}`, { method, signal,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          ...(method === 'GET' ? {} : { Origin: ORIGIN, 'X-CSRF-Token': csrf }) },
        body: body === undefined ? undefined : JSON.stringify(body) })
    } catch (error) {
      return { status: error?.name === 'TimeoutError' ? 'timeout' : 'network', ms: performance.now() - started }
    }
    let result
    try {
      result = await response.json()
    } catch (error) {
      return { status: signal.aborted ? 'timeout' : `${response.status} sin JSON`, ms: performance.now() - started }
    }
    const ms = performance.now() - started
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';'); const at = pair.indexOf('=')
      cookies.set(pair.slice(0, at), pair.slice(at + 1))
    }
    if (result?.csrfToken) csrf = result.csrfToken
    const outcome = { status: response.status, body: result, retryAfter: response.headers.get('retry-after'), ms }
    try {
      assertContract(method, path, response, result)
    } catch (error) {
      contractViolations.push(`${method} ${path} ${response.status}: ${String(error?.message).replace(/\s+/g, ' ').slice(0, 300)}`)
      return { ...outcome, contract: false }
    }
    return outcome
  }
  assert.equal((await call('GET', '/auth/session')).status, 200, 'la sesión sembrada debe ser válida')
  return { userId, call }
}
async function health() {
  await pace()
  const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) })
  return { status: response.status, body: await response.json() }
}

/** Percentil por rango más cercano: el menor valor que deja al menos p de las muestras a su izquierda. */
function summary(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const at = p => sorted.length ? Math.round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] * 10) / 10 : null
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) }
}
const summarize = groups => Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, summary(values)]))
/**
 * Etiqueta de una respuesta: la del esperado según `classify`, o estado y código si es inesperada.
 * Una respuesta fuera de contrato nunca es esperada, aunque su estado lo sea.
 */
function labelOf(result, classify) {
  const label = result.contract === false ? null : classify(result)
  if (label) return { key: label, expected: true }
  const code = result.body?.error?.code ? ` ${result.body.error.code}` : ''
  return { key: `${result.status}${code}${result.contract === false ? ' fuera de contrato' : ''}`, expected: false }
}
function tally(results, classify) {
  const counts = { expected: {}, unexpected: {} }
  for (const result of results) {
    const { key, expected } = labelOf(result, classify)
    const bucket = expected ? counts.expected : counts.unexpected
    bucket[key] = (bucket[key] ?? 0) + 1
  }
  return counts
}
/** Latencias del cliente por etiqueta: un rechazo rápido no se mezcla con una reserva creada. */
function latencyByLabel(results, classify) {
  const groups = {}
  for (const result of results) (groups[labelOf(result, classify).key] ??= []).push(result.ms)
  return summarize(groups)
}
const totalOf = counts => Object.values(counts).reduce((sum, n) => sum + n, 0)

/** Muestrea cada 10 ms cuántas sesiones esperan un bloqueo: evidencia de que la contienda llegó a la base. */
function sampleLockWaits() {
  let running = true
  const stats = { samples: 0, withWaiters: 0, maxWaiters: 0 }
  const loop = (async () => {
    while (running) {
      const { rows: [row] } = await observer.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`)
      stats.samples++
      if (row.waiting > 0) stats.withWaiters++
      stats.maxWaiters = Math.max(stats.maxWaiters, row.waiting)
      await sleep(10)
    }
  })()
  return async () => { running = false; await loop; return stats }
}

let north
let south
const makeLots = async (count, quantity, label, establishmentId = north) => (await database.query(`INSERT INTO lots
    (establishment_id, description, category, quantity, address, latitude, longitude, time_zone,
     pickup_starts_at, pickup_ends_at, status, published_at)
  SELECT $1, $2, 'Panadería', $3, 'Santiago Centro', -33.45, -70.66, 'America/Santiago',
    now() - interval '1 hour', now() + interval '2 hours', 'published', now() - interval '2 hours'
  FROM generate_series(1, $4) RETURNING public_id::text AS id`, [establishmentId, `K039 ${label}`, quantity, count])).rows.map(row => row.id)
/** Contadores del lote y sus compromisos, por identificador público. */
const lotState = async lotIds => new Map((await database.query(`SELECT l.public_id::text AS id,
    json_build_object('f', l.free_quantity, 'o', l.offered_quantity, 'r', l.reserved_quantity,
      'e', l.delivered_quantity, 'x', l.expired_quantity) AS counters,
    ARRAY(SELECT c.public_id::text FROM commitments c WHERE c.lot_id = l.id ORDER BY c.id) AS commitments
  FROM lots l WHERE l.public_id = ANY($1::uuid[])`, [lotIds])).rows.map(row => [row.id, row]))
/**
 * Lotes descuadrados (anexos B p. 4). Q = F + O + R + E + X sin negativos lo garantiza el esquema
 * (F es columna generada y hay CHECK de contadores y total); se repite por si el esquema cambia.
 * Lo que la consulta prueba de verdad es R, O y E iguales a sus registros; X se compara por caso.
 */
const unreconciled = async (lotIds = null) => (await database.query(`SELECT l.public_id::text AS id FROM lots l
  WHERE ($1::uuid[] IS NULL OR l.public_id = ANY($1::uuid[])) AND (
    l.quantity <> l.free_quantity + l.offered_quantity + l.reserved_quantity + l.delivered_quantity + l.expired_quantity
    OR LEAST(l.free_quantity, l.offered_quantity, l.reserved_quantity, l.delivered_quantity, l.expired_quantity) < 0
    OR l.reserved_quantity <> COALESCE((SELECT sum(c.quantity) FROM commitments c WHERE c.lot_id = l.id AND c.status = 'confirmed'), 0)
    OR l.offered_quantity <> COALESCE((SELECT sum(w.offered_quantity) FROM waitlist_entries w
      WHERE w.lot_id = l.id AND w.status = 'offered'), 0)
    OR l.delivered_quantity <> COALESCE((SELECT sum(d.quantity) FROM deliveries d
      JOIN commitments c ON c.id = d.commitment_id WHERE c.lot_id = l.id), 0))`, [lotIds])).rows.map(row => row.id)
const INVENTORY_RULE = 'R, O y E iguales a sus registros; Q = F + O + R + E + X sin negativos lo garantiza el esquema'

const cases = []
/**
 * Ejecuta un caso y guarda su registro aunque falle; `body` completa observed y statusCounts.
 * `expectedResponsesMet` dice si todas las respuestas fueron las esperadas: se informa, pero pass
 * depende solo de la integridad, de las aserciones y del contrato.
 */
async function runCase(definition, body) {
  const record = { ...definition, observed: {}, statusCounts: { expected: {}, unexpected: {} }, durationMs: 0, pass: false }
  const firstRequest = requests.length
  const firstViolation = contractViolations.length
  const started = performance.now()
  let line = ''
  try {
    line = await body(record)
    record.pass = true
  } catch (error) {
    // Sin la pila: un error de pg puede traer SQL, nunca la URL.
    record.error = (error instanceof assert.AssertionError ? error.message : `${error?.code ?? error?.name}: ${error?.message}`)
      .replace(/\s+/g, ' ').trim()
    line = record.error
  }
  record.durationMs = Math.round(performance.now() - started)
  record.contractViolations = contractViolations.slice(firstViolation)
  if (record.pass && record.contractViolations.length) {
    record.pass = false
    record.error = line = `${record.contractViolations.length} respuestas fuera del contrato OpenAPI`
  }
  const unexpected = totalOf(record.statusCounts.unexpected)
  record.expectedResponsesMet = unexpected === 0 && (record.expectedResponsesMet ?? true)
  const byOperation = {}
  for (const event of requests.slice(firstRequest)) (byOperation[`${event.operation} ${event.status}`] ??= []).push(event.durationMs)
  if (Object.keys(byOperation).length) {
    record.observed.serverDurationMs = summarize(byOperation)
    record.observed.latencyNote = LATENCY_NOTE
  }
  cases.push(record)
  console.log(`${record.pass ? 'OK' : 'FAIL'} ${cases.length}: ${record.name}: ${line}`
    + `${unexpected ? ` (${unexpected} respuestas inesperadas)` : ''} [${(record.durationMs / 1000).toFixed(1)} s]`)
}

// Sin recortar el inicio: git status --porcelain empieza cada línea con dos columnas de estado.
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd() } catch { return null }
}
const sha256Of = file => { try { return createHash('sha256').update(readFileSync(file)).digest('hex') } catch { return null } }
async function describeEnvironment() {
  const { rows: [db] } = await database.query(`SELECT version() AS postgres,
    (SELECT extversion FROM pg_extension WHERE extname = 'postgis') AS postgis, postgis_lib_version() AS postgis_lib,
    current_setting('max_connections') AS max_connections, current_setting('shared_buffers') AS shared_buffers`)
  let runtime = null
  try { runtime = JSON.parse(process.env.K039_RUNTIME ?? 'null') } catch { runtime = null }
  const status = git('status', '--porcelain')
  return {
    commit: git('rev-parse', 'HEAD'), dirtyTree: status === null ? null : status !== '',
    dirtyPaths: status ? status.split('\n').map(line => line.slice(3)) : [],
    // Con el árbol sucio el commit no basta: el hash identifica la versión de los scripts que corrió.
    scriptsSha256: { 'api/scripts/test-integrity.mjs': sha256Of(fileURLToPath(import.meta.url)),
      'api/scripts/test-integrity-compose.mjs': sha256Of(`${apiDirectory}scripts/test-integrity-compose.mjs`) },
    // El núcleo dice la arquitectura del equipo y process.arch la del binario de Node: difieren si Node corre traducido.
    os: `${os.type()} ${os.release()}`, kernel: os.version(), cpu: `${os.cpus()[0]?.model} × ${os.cpus().length}`,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10, node: `${process.version} ${process.arch}`,
    postgres: db.postgres, postgis: `${db.postgis} (lib ${db.postgis_lib})`,
    postgresSettings: { maxConnections: Number(db.max_connections), sharedBuffers: db.shared_buffers },
    containers: runtime,
    topology: 'API real (createApi) en el mismo proceso Node que el generador, por HTTP en 127.0.0.1; '
      + 'worker real (dist/worker.js) como proceso aparte en el caso de tareas vencidas; PostgreSQL con PostGIS '
      + 'en el servicio db de Compose. Un solo equipo: generador, API y base comparten CPU y memoria.',
    pools: { api: 8, useCases: 8, worker: 2 },
    seed: 'Sin semilla aleatoria: cada caso crea sus lotes, usuarios y sesiones con SQL y UUID nuevos.',
  }
}

try {
  await database.connect()
  await observer.connect()
  await blocker.connect()
  const environment = await describeEnvironment()
  const establishment = async name => (await database.query(`INSERT INTO establishments
    (name, address, latitude, longitude, time_zone) VALUES ($1, 'Santiago', -33.45, -70.66, 'America/Santiago')
    RETURNING id`, [name])).rows[0].id
  north = await establishment('K039 Norte')
  south = await establishment('K039 Sur')

  // --- 1. Último pack: 20 personas por un pack, en 100 lotes nuevos.
  await runCase({
    name: 'Último pack',
    anexo: { page: 23, text: '20 solicitudes concurrentes por un pack, repetidas en 100 lotes nuevos. Exactamente una reserva por lote y stock final cero.' },
    parameters: { lots: 100, packsPerLot: 1, concurrentRequestsPerLot: 20, distinctPersonsPerLot: 20,
      persons: 'las mismas 20 personas en cada lote, cada una con su sesión y una clave nueva por solicitud',
      request: 'POST /public/lots/{lotId}/reservations {quantity: 1}', requestTimeoutMs: 10_000,
      pace: 'ráfaga de 20 cuando la cubeta local (35/s, ráfaga 80) tiene saldo para todas' },
    expected: { responsesPerLot: '1 × 201 y 19 × 409 sin stock (fallo esperado)', reservationsPerLot: 1,
      countersPerLot: { f: 0, o: 0, r: 1, e: 0, x: 0 }, inventory: INVENTORY_RULE,
      unexpected: '429, 5xx, timeout u otro 409 se cuentan aparte; el criterio de PASS es la integridad' },
  }, async record => {
    const contenders = []
    for (let i = 0; i < 20; i++) contenders.push(await person(`ultimo-${i}`))
    const lots = await makeLots(100, 1, 'último pack')
    const stopSampling = sampleLockWaits()
    const perLot = []
    try {
      for (const lotId of lots) {
        await pace(20)
        perLot.push({ lotId, results: await Promise.all(contenders.map(who => who.call('POST', `/public/lots/${lotId}/reservations`,
          { quantity: 1, idempotencyKey: randomUUID() }, { prepaid: true }))) })
      }
    } finally { record.observed.lockWaits = await stopSampling() }
    const all = perLot.flatMap(lot => lot.results)
    const classify = result => result.status === 201 ? '201'
      : result.status === 409 && result.body?.error?.message === NO_STOCK ? '409 sin stock' : null
    record.statusCounts = tally(all, classify)
    const stored = await lotState(lots)
    const broken = []
    let answered = 0
    for (const { lotId, results } of perLot) {
      const created = results.filter(result => result.status === 201)
      const row = stored.get(lotId)
      if (created.length === 1) answered++
      if (row.commitments.length !== 1 || !isDeepStrictEqual(row.counters, { f: 0, o: 0, r: 1, e: 0, x: 0 })
        || created.length > 1 || created.some(result => result.body.id !== row.commitments[0])) {
        broken.push({ lotId, created: created.length, commitments: row.commitments.length, counters: row.counters })
      }
    }
    // Un lote cuyo ganador no recibió su 201 (timeout) conserva la integridad, pero no la respuesta esperada.
    record.expectedResponsesMet = answered === lots.length
    const unreconciledLots = await unreconciled(lots)
    Object.assign(record.observed, { lots: lots.length, requests: all.length,
      lotsWithOneReservationAndFreeZero: lots.length - broken.length, lotsAnsweredWithOne201: answered,
      brokenLots: broken, unreconciledLots, clientLatencyMs: latencyByLabel(all, classify),
      note: 'Con el pool de 8 de la API, a lo más 7 transacciones esperan el bloqueo del lote y el resto espera conexión.' })
    assert.deepEqual(broken, [], 'cada lote debe terminar con una sola reserva, F = 0 y sin 201 sin respaldo')
    assert.deepEqual(unreconciledLots, [])
    const { expected } = record.statusCounts
    return `${lots.length} lotes con una reserva y F = 0; ${expected['201'] ?? 0} × 201, ${expected['409 sin stock'] ?? 0} × 409 sin stock`
  })

  // --- 2. Misma intención: 20 reintentos simultáneos de una clave, persona nueva por lote.
  await runCase({
    name: 'Misma intención (reserva)',
    anexo: { page: 23, text: '20 reintentos concurrentes de una clave. Un compromiso, un descuento y el mismo identificador de resultado.' },
    parameters: { lots: 10, packsPerLot: 5, quantity: 2, concurrentRetries: 20, sameUserKeyAndBody: true,
      persons: 'una persona nueva por lote, sin escrituras previas (ráfaga de escrituras por usuario: 20)',
      request: 'POST /public/lots/{lotId}/reservations {quantity: 2, idempotencyKey}', requestTimeoutMs: 10_000 },
    expected: { responsesPerLot: '20 × 201 con el mismo cuerpo', commitmentsPerKey: 1,
      countersPerLot: { f: 3, o: 0, r: 2, e: 0, x: 0 }, inventory: 'un solo descuento: R = 2 y F = 3' },
  }, async record => {
    const stopSampling = sampleLockWaits()
    const perLot = []
    try {
      for (let i = 0; i < 10; i++) {
        const who = await person(`intencion-${i}`)
        const [lotId] = await makeLots(1, 5, 'misma intención')
        const body = { quantity: 2, idempotencyKey: randomUUID() }
        await pace(20)
        const results = await Promise.all(Array.from({ length: 20 }, () =>
          who.call('POST', `/public/lots/${lotId}/reservations`, body, { prepaid: true })))
        perLot.push({ lotId, userId: who.userId, key: body.idempotencyKey, results })
      }
    } finally { record.observed.lockWaits = await stopSampling() }
    const all = perLot.flatMap(lot => lot.results)
    const classify = result => result.status === 201 ? '201' : null
    record.statusCounts = tally(all, classify)
    const stored = await lotState(perLot.map(lot => lot.lotId))
    const broken = []
    for (const { lotId, userId, key, results } of perLot) {
      const created = results.filter(result => result.status === 201)
      const row = stored.get(lotId)
      const { rows: [{ n: byKey }] } = await database.query(
        'SELECT count(*)::int AS n FROM commitments WHERE user_id = $1 AND idempotency_key = $2', [userId, key])
      // Sin ningún 201 no hay identificador que comparar: el lote no prueba la misma intención.
      if (byKey !== 1 || row.commitments.length !== 1 || !isDeepStrictEqual(row.counters, { f: 3, o: 0, r: 2, e: 0, x: 0 })
        || created.length === 0 || created.some(result => !isDeepStrictEqual(result.body, created[0].body))
        || created[0].body.id !== row.commitments[0]) {
        broken.push({ lotId, created: created.length, distinctIds: new Set(created.map(result => result.body.id)).size,
          commitmentsByKey: byKey, counters: row.counters })
      }
    }
    record.expectedResponsesMet = perLot.every(lot => lot.results.filter(result => result.status === 201).length === 20)
    const unreconciledLots = await unreconciled(perLot.map(lot => lot.lotId))
    Object.assign(record.observed, { lots: perLot.length, requests: all.length,
      lotsWithOneCommitmentAndOneDiscount: perLot.length - broken.length, brokenLots: broken, unreconciledLots,
      clientLatencyMs: latencyByLabel(all, classify) })
    assert.deepEqual(broken, [], 'cada clave debe dejar un compromiso, un descuento y el mismo resultado')
    assert.deepEqual(unreconciledLots, [])
    return `${perLot.length} lotes con un compromiso y un descuento por clave; ${record.statusCounts.expected['201'] ?? 0} × 201 idénticos`
  })

  // --- 3. Misma intención en el chat: 20 envíos simultáneos del titular con la misma clave.
  await runCase({
    name: 'Misma intención (chat)',
    anexo: { page: 23, text: '20 reintentos concurrentes de una clave. Un compromiso, un descuento y el mismo identificador de resultado.',
      related: { page: 21, text: 'Envío de mensajes: máximo 12 por minuto y usuario, con ráfaga de tres. El exceso recibe rechazo temporal.' } },
    parameters: { concurrentSends: 20, sameUserKeyAndText: true, operatorsOfEstablishment: 2,
      reservation: 'creada con el caso de uso, sin gastar escrituras HTTP del titular',
      http: 'POST /reservations/{reservationId}/messages {text, idempotencyKey}, 20 simultáneos. El cupo de mensajes '
        + `(ráfaga ${MESSAGE_BURST}) se cobra antes del caso de uso: solo ${MESSAGE_BURST} envíos llegan a la persistencia`,
      useCase: 'send del caso de uso con otra clave, 20 llamadas simultáneas sin HTTP ni cupo: 20 reintentos concurrentes en la persistencia',
      requestTimeoutMs: 10_000 },
    expected: { http: { created: `${MESSAGE_BURST} × 201 con el mismo id, sequence y createdAt`,
      rateLimited: `${20 - MESSAGE_BURST} × 429 RATE_LIMITED con Retry-After ≥ 2 por el cupo de mensajes (fallo esperado)` },
    useCase: '20 resultados con el mismo id, sequence y createdAt', messagesPerKey: 1,
    outboxEventsPerMessage: 'uno message_from_holder por operador destinatario' },
  }, async record => {
    const operators = [await seedUser('chat-operadora-1', north), await seedUser('chat-operadora-2', north)]
    const holder = await person('chat-titular')
    const [lotId] = await makeLots(1, 5, 'chat')
    const reservation = await discovery.reserve({ userId: holder.userId }, lotId, 1, randomUUID())
    const viaHttp = { text: 'K039: ¿a qué hora paso a retirar?', idempotencyKey: randomUUID() }
    await pace(20)
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      holder.call('POST', `/reservations/${reservation.id}/messages`, viaHttp, { prepaid: true })))
    const classify = result => result.status === 201 ? '201'
      : result.status === 429 && result.body?.error?.code === 'RATE_LIMITED' && Number(result.retryAfter) >= 2
        ? '429 RATE_LIMITED (cupo de mensajes)' : null
    record.statusCounts = tally(results, classify)
    const created = results.filter(result => result.status === 201)

    const direct = { text: 'K039: ¿sigue disponible el pack?', idempotencyKey: randomUUID() }
    const settled = await Promise.allSettled(Array.from({ length: 20 }, () =>
      chat.send({ userId: holder.userId }, reservation.id, direct.text, direct.idempotencyKey)))
    const sent = settled.filter(outcome => outcome.status === 'fulfilled')
      .map(({ value }) => ({ id: value.id, sequence: value.sequence, createdAt: value.createdAt.toISOString() }))
    const rejected = settled.filter(outcome => outcome.status === 'rejected')
      .map(({ reason }) => `${reason?.code ?? reason?.name}: ${reason?.message}`.replace(/\s+/g, ' '))

    const stored = async key => (await database.query(`SELECT m.id::text AS internal, m.public_id::text AS id, m.sequence,
        m.author_user_id::text AS author FROM chat_messages m JOIN commitments c ON c.id = m.commitment_id
      WHERE c.public_id = $1 AND m.idempotency_key = $2`, [reservation.id, key])).rows
    // Se comparan como conjuntos ordenados igual a ambos lados: el orden de los ids no importa.
    const recipientsOf = async message => (await database.query(`SELECT event_type || ' ' || recipient_user_id AS event
      FROM outbox_events WHERE subject_id = $1 AND event_type LIKE 'message_from_%'`, [message.internal])).rows.map(row => row.event).sort()
    const expectedEvents = operators.map(id => `message_from_holder ${id}`).sort()
    const httpMessages = await stored(viaHttp.idempotencyKey)
    const directMessages = await stored(direct.idempotencyKey)
    const httpEvents = httpMessages.length === 1 ? await recipientsOf(httpMessages[0]) : []
    const directEvents = directMessages.length === 1 ? await recipientsOf(directMessages[0]) : []
    const rateLimited = record.statusCounts.expected['429 RATE_LIMITED (cupo de mensajes)'] ?? 0
    Object.assign(record.observed, {
      http: { created: created.length, rateLimited, rows: httpMessages.length, sequence: httpMessages[0]?.sequence ?? null,
        outboxEvents: httpEvents, identicalBodies: created.every(result => isDeepStrictEqual(result.body, created[0].body)),
        concurrencyInPersistence: `${created.length} envíos pasaron el cupo y llegaron al caso de uso` },
      useCase: { calls: settled.length, fulfilled: sent.length, rejected, rows: directMessages.length,
        sequence: directMessages[0]?.sequence ?? null, outboxEvents: directEvents,
        identicalResults: sent.every(value => isDeepStrictEqual(value, sent[0])) },
    })
    assert.equal(created.length, MESSAGE_BURST, 'pasan el cupo exactamente los envíos de su ráfaga')
    assert.equal(httpMessages.length, 1, 'una sola fila en chat_messages por la clave enviada por HTTP')
    assert.equal(httpMessages[0].author, holder.userId)
    assert.ok(record.observed.http.identicalBodies, 'todas las 201 devuelven el mismo mensaje')
    assert.deepEqual([created[0].body.id, created[0].body.sequence], [httpMessages[0].id, httpMessages[0].sequence])
    assert.deepEqual(httpEvents, expectedEvents, 'un evento outbox por operador destinatario')
    assert.deepEqual(rejected, [], 'ningún reintento concurrente del caso de uso falla')
    assert.equal(directMessages.length, 1, 'una sola fila en chat_messages por la clave del caso de uso')
    assert.ok(record.observed.useCase.identicalResults, 'los 20 reintentos devuelven el mismo mensaje')
    assert.deepEqual([sent[0].id, sent[0].sequence], [directMessages[0].id, directMessages[0].sequence])
    assert.deepEqual(directEvents, expectedEvents, 'un evento outbox por operador destinatario')
    return `HTTP: 1 mensaje y ${httpEvents.length} eventos; ${created.length} × 201 idénticos, ${rateLimited} × 429 por el cupo `
      + `de mensajes. Caso de uso: 20 reintentos, 1 mensaje y ${directEvents.length} eventos`
  })

  // --- 4. Oferta antes, en y después del plazo, con el trabajador detenido.
  await runCase({
    name: 'Oferta y vencimiento en el límite',
    anexo: { page: 23, text: 'Pruebas antes, en y después del límite, con trabajador detenido. En el límite ya no se acepta.' },
    parameters: { worker: `detenido según /health: sin latido o con el último ciclo hace más de ${WORKER_STALE_SECONDS} s `
        + '(si una corrida anterior dejó un latido reciente, se espera a que quede viejo)',
      before: 'offer_expires_at = reloj de PostgreSQL + 30 s; aceptar',
      atLimit: 'plazo cruzado mientras la aceptación espera el bloqueo del lote: offer_expires_at = reloj + 1,2 s; otra '
        + 'transacción bloquea el lote (SELECT … FOR UPDATE), la aceptación espera, el reloj cruza el plazo y se libera el '
        + 'bloqueo (lock_timeout de la API: 2 s)',
      exactEquality: 'el instante igual al plazo (now >= offer_expires_at ya vence) no se alcanza por HTTP; lo cubren '
        + 'api/test/waitlist-domain.test.ts («estado vigente») y settleQueue (offer_expires_at <= now)',
      after: 'offer_expires_at = reloj − 1 s, sin registrar; aceptar',
      request: 'POST /waitlist/{entryId}/accept' },
    expected: { before: '200 aceptada: O → R', atLimit: '409 vencida sin asignar; ended_at = offer_expires_at',
      after: '409 vencida sin asignar', countersAfterExpiry: { f: 1, o: 0, r: 0, e: 0, x: 0 } },
  }, async record => {
    const heartbeatAge = async () => (await database.query(`SELECT extract(epoch FROM clock_timestamp() - last_cycle_at)::float AS age
      FROM worker_heartbeat`)).rows[0]?.age ?? null
    const stopped = age => age === null || age > WORKER_STALE_SECONDS
    const ageBefore = await heartbeatAge()
    const waitStarted = performance.now()
    await until('latido viejo de un worker anterior', async () => stopped(await heartbeatAge()), (WORKER_STALE_SECONDS + 15) * 1000)
    const probe = await health()
    record.observed.worker = { heartbeatAgeBeforeS: ageBefore === null ? null : Math.round(ageBefore),
      waitedForStaleHeartbeatMs: Math.round(performance.now() - waitStarted), health: probe.body.worker }
    assert.deepEqual([probe.status, probe.body.worker], [200, 'stopped'])
    const holderId = await seedUser('oferta-titular')
    const waiter = await person('oferta-espera')
    const stored = async entryId => (await database.query(`SELECT w.status, w.offer_expires_at, w.ended_at,
        w.commitment_id IS NOT NULL AS assigned, l.public_id::text AS lot FROM waitlist_entries w JOIN lots l ON l.id = w.lot_id
      WHERE w.public_id = $1`, [entryId])).rows[0]
    // Reservar, esperar y cancelar con los casos de uso deja una oferta de 1 pack a la persona en espera.
    async function offer(label) {
      const [lotId] = await makeLots(1, 1, `oferta ${label}`)
      const held = await discovery.reserve({ userId: holderId }, lotId, 1, randomUUID())
      const entry = await waitlist.join({ userId: waiter.userId }, lotId, 1, randomUUID())
      assert.equal(entry.status, 'waiting')
      await reservations.cancel({ userId: holderId }, held.id)
      assert.equal((await stored(entry.id)).status, 'offered')
      return { lotId, entryId: entry.id }
    }
    const results = []
    const classify = result => result.step === 'antes' && result.status === 200 ? '200 aceptada (antes)'
      : result.step !== 'antes' && result.status === 409 && result.body?.error?.message === OFFER_EXPIRED ? `409 vencida (${result.step})` : null
    const accept = async (step, entryId) => {
      const result = { step, ...await waiter.call('POST', `/waitlist/${entryId}/accept`, {}) }
      results.push(result)
      record.statusCounts = tally(results, classify)
      return result
    }
    const setDeadline = async (entryId, offset, shiftOffered = false) => (await database.query(`UPDATE waitlist_entries
      SET offered_at = offered_at - CASE WHEN $3 THEN interval '1 hour' ELSE interval '0' END,
        offer_expires_at = date_trunc('milliseconds', clock_timestamp() + $2::interval)
      WHERE public_id = $1 RETURNING offer_expires_at`, [entryId, offset, shiftOffered])).rows[0].offer_expires_at

    // (a) Antes del plazo: la aceptación confirma O → R.
    const early = await offer('antes')
    const earlyDeadline = await setDeadline(early.entryId, '30 seconds')
    const accepted = await accept('antes', early.entryId)
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.status, 'accepted')
    const earlyRow = await stored(early.entryId)
    const { rows: [{ created }] } = await database.query('SELECT created_at AS created FROM commitments WHERE public_id = $1',
      [accepted.body.reservationId])
    assert.ok(created < earlyDeadline, 'la reserva nace antes del plazo')
    assert.deepEqual([earlyRow.status, earlyRow.assigned], ['accepted', true])
    assert.deepEqual((await lotState([early.lotId])).get(early.lotId).counters, { f: 0, o: 0, r: 1, e: 0, x: 0 })

    // (b) En el límite: la aceptación espera el bloqueo y lo obtiene después del plazo.
    const edge = await offer('en el límite')
    const deadline = await setDeadline(edge.entryId, '1200 milliseconds')
    let pending = null
    let waiting = null
    await blocker.query('BEGIN')
    try {
      const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid')
      await blocker.query('SELECT id FROM lots WHERE public_id = $1 FOR UPDATE', [edge.lotId])
      pending = accept('límite', edge.entryId).then(value => ({ value }), error => ({ error }))
      for (const limit = performance.now() + 1000; !waiting && performance.now() < limit;) {
        waiting = (await observer.query(`SELECT a.wait_event, clock_timestamp() < $2 AS before_deadline FROM pg_stat_activity a
          WHERE a.datname = current_database() AND a.wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(a.pid))`,
        [pid, deadline])).rows[0] ?? null
        if (!waiting) await sleep(10)
      }
      assert.ok(waiting?.before_deadline, 'la aceptación debe quedar esperando el bloqueo del lote antes del plazo')
      await blocker.query('SELECT pg_sleep(GREATEST(0, extract(epoch FROM ($1::timestamptz - clock_timestamp()))))', [deadline])
      assert.ok((await blocker.query('SELECT clock_timestamp() >= $1 AS crossed', [deadline])).rows[0].crossed)
      await blocker.query('COMMIT')
    } catch (error) {
      await blocker.query('ROLLBACK').catch(() => {})
      await pending
      throw error
    }
    const outcome = await pending
    if (outcome.error) throw outcome.error
    const late = outcome.value
    const edgeRow = await stored(edge.entryId)
    const { rows: [decision] } = await database.query(`SELECT e.created_at FROM outbox_events e JOIN waitlist_entries w
      ON w.id = e.subject_id WHERE e.event_type = 'offer_expired' AND w.public_id = $1`, [edge.entryId])
    record.observed.atLimit = { status: late.status, lockWaitObserved: Boolean(waiting), waitEvent: waiting?.wait_event ?? null,
      entryStatus: edgeRow.status, endedAtEqualsDeadline: edgeRow.ended_at?.getTime() === deadline.getTime(),
      decidedAfterDeadlineMs: decision ? decision.created_at.getTime() - deadline.getTime() : null,
      note: 'Se decide con el reloj tomado tras obtener el bloqueo, unos ms después del plazo; la igualdad exacta se cubre en '
        + 'waitlist-domain.test.ts y settleQueue.' }
    assert.equal(late.status, 409, 'en el límite ya no se acepta')
    assert.equal(late.body.error.message, OFFER_EXPIRED)
    assert.deepEqual([edgeRow.status, edgeRow.assigned, edgeRow.ended_at.getTime()], ['expired', false, deadline.getTime()])
    assert.ok(decision && decision.created_at >= deadline, 'el vencimiento se decide con el reloj posterior a la espera')
    assert.deepEqual((await lotState([edge.lotId])).get(edge.lotId).counters, { f: 1, o: 0, r: 0, e: 0, x: 0 })

    // (c) Después del plazo, sin trabajador que lo haya registrado: la aceptación lo registra y se rechaza.
    const after = await offer('después')
    const past = await setDeadline(after.entryId, '-1 second', true)
    assert.equal((await stored(after.entryId)).status, 'offered', 'nadie registró el vencimiento')
    assert.equal((await database.query(`SELECT count(*)::int AS n FROM (${DUE_LOTS}) d JOIN lots l ON l.id = d.lot_id
      WHERE l.public_id = $1`, [after.lotId])).rows[0].n, 1, 'el lote figura con un vencimiento pendiente')
    const rejected = await accept('después', after.entryId)
    const afterRow = await stored(after.entryId)
    assert.equal(rejected.status, 409)
    assert.equal(rejected.body.error.message, OFFER_EXPIRED)
    assert.deepEqual([afterRow.status, afterRow.assigned, afterRow.ended_at.getTime()], ['expired', false, past.getTime()])
    assert.deepEqual((await lotState([after.lotId])).get(after.lotId).counters, { f: 1, o: 0, r: 0, e: 0, x: 0 })

    const lots = [early.lotId, edge.lotId, after.lotId]
    const unreconciledLots = await unreconciled(lots)
    const { rows: [{ n: waiterCommitments }] } = await database.query(`SELECT count(*)::int AS n FROM commitments c
      JOIN lots l ON l.id = c.lot_id WHERE c.user_id = $1 AND l.public_id = ANY($2::uuid[])`, [waiter.userId, lots])
    const stillStopped = stopped(await heartbeatAge())
    Object.assign(record.observed, { before: { status: accepted.status, entryStatus: earlyRow.status },
      after: { status: rejected.status, entryStatus: afterRow.status }, waiterCommitments, unreconciledLots,
      workerStillStopped: stillStopped })
    assert.equal(waiterCommitments, 1, 'solo la aceptación antes del plazo asigna')
    assert.deepEqual(unreconciledLots, [])
    assert.ok(stillStopped, 'ningún worker registró un ciclo durante el caso')
    return `antes 200; en el límite espera ${waiting.wait_event} y responde 409 `
      + `(${record.observed.atLimit.decidedAfterDeadlineMs} ms tras el plazo); después 409; sin asignar tras el plazo`
  })

  // --- 5. Aislamiento: un operador de otro establecimiento con una reserva ajena.
  await runCase({
    name: 'Aislamiento: operador ajeno',
    anexo: { page: 23, text: 'Usuario y operador ajenos intentan consultar, cancelar, enviar o retirar. Todos los accesos indebidos son rechazados.' },
    parameters: { actor: 'operador con membresía solo en otro establecimiento',
      holderRoutes: ['GET /reservations/{id}', 'POST /reservations/{id}/cancel', 'POST /reservations/{id}/messages'],
      operatorRoutes: ['GET /establishments/{id}/commitments', 'POST /lots/{lotId}/pickup-reviews {code}',
        'POST /lots/{lotId}/pickups {reservationId, code, idempotencyKey}'],
      code: 'el código válido de la reserva, leído por su titular',
      control: 'el titular consulta la misma reserva antes y después',
      alreadyCovered: 'usuario ajeno al consultar y cancelar (test-security, test-reservations); operador de otro local en '
        + 'lotes, fotos, revisar y confirmar retiro (test-security), revisar (test-reservations), panel, compromisos e '
        + 'historial (test-panel) y chat (test-chat)' },
    expected: { holderRoutes: '404 NOT_FOUND: la reserva se busca por su titular, así que una membresía no abre estas rutas',
      operatorRoutes: '403 FORBIDDEN: sin membresía en el establecimiento del lote, aun con el código válido',
      reservation: 'sigue confirmada, con código, sin entrega, sin mensajes y sin fallos de código del operador ajeno' },
  }, async record => {
    const holder = await person('aislamiento-titular')
    const outsider = await person('aislamiento-operador', south)
    const [lotId] = await makeLots(1, 3, 'aislamiento')
    const reservation = await discovery.reserve({ userId: holder.userId }, lotId, 1, randomUUID())
    const { rows: [{ id: northId }] } = await database.query('SELECT public_id::text AS id FROM establishments WHERE id = $1', [north])
    const snapshot = async () => (await database.query(`SELECT c.status, c.ended_at, c.pickup_code_ciphertext IS NOT NULL AS readable,
        l.free_quantity AS f, l.reserved_quantity AS r,
        (SELECT count(*)::int FROM deliveries d WHERE d.commitment_id = c.id) AS deliveries,
        (SELECT count(*)::int FROM chat_messages m WHERE m.commitment_id = c.id) AS messages,
        (SELECT count(*)::int FROM pickup_code_failures p WHERE p.user_id = $2) AS outsider_failures
      FROM commitments c JOIN lots l ON l.id = c.lot_id WHERE c.public_id = $1`, [reservation.id, outsider.userId])).rows[0]
    const before = await snapshot()
    const controlBefore = await holder.call('GET', `/reservations/${reservation.id}`)
    assert.equal(controlBefore.status, 200)
    const code = controlBefore.body.pickupCode
    const attempts = []
    const attempt = async (route, method, path, body) => attempts.push({ route, ...await outsider.call(method, path, body) })
    await attempt('titular', 'GET', `/reservations/${reservation.id}`)
    await attempt('titular', 'POST', `/reservations/${reservation.id}/cancel`, {})
    await attempt('titular', 'POST', `/reservations/${reservation.id}/messages`, { text: 'K039: mensaje ajeno', idempotencyKey: randomUUID() })
    await attempt('operador', 'GET', `/establishments/${northId}/commitments`)
    await attempt('operador', 'POST', `/lots/${lotId}/pickup-reviews`, { code })
    await attempt('operador', 'POST', `/lots/${lotId}/pickups`, { reservationId: reservation.id, code, idempotencyKey: randomUUID() })
    record.statusCounts = tally(attempts, result =>
      result.route === 'titular' && result.status === 404 && result.body?.error?.code === 'NOT_FOUND' ? '404 (ruta del titular)'
        : result.route === 'operador' && result.status === 403 && result.body?.error?.code === 'FORBIDDEN' ? '403 (ruta de operador)' : null)
    const control = await holder.call('GET', `/reservations/${reservation.id}`)
    const after = await snapshot()
    Object.assign(record.observed, { attempts: attempts.map(result => `${result.route} ${result.status}`), control: control.status,
      unchanged: isDeepStrictEqual(before, after), reservation: after })
    assert.deepEqual(attempts.map(result => result.status), [404, 404, 404, 403, 403, 403])
    assert.deepEqual([control.status, control.body.status, control.body.pickupCode], [200, 'confirmed', code])
    assert.ok(record.observed.unchanged, 'la reserva no cambia')
    assert.deepEqual([after.status, after.ended_at, after.readable, after.f, after.r, after.deliveries, after.messages, after.outsider_failures],
      ['confirmed', null, true, 2, 1, 0, 0, 0])
    return 'consultar, cancelar y escribir responden 404; compromisos, revisar y confirmar el retiro responden 403; la reserva sigue igual'
  })

  // --- 6. Tareas vencidas: 100 ofertas con el mismo plazo y el worker real sano.
  await runCase({
    name: 'Tareas vencidas',
    anexo: { page: 19, text: 'Con trabajador sano, P95 ≤ 30 s desde el vencimiento hasta persistir el estado y aviso. Se siembran al menos 100 ofertas con plazos conocidos.' },
    parameters: { offers: 100, lots: 100, sameDeadline: 'offer_expires_at = reloj de PostgreSQL + 5 s para todas (peor caso)',
      setup: 'reservar, entrar a la espera y cancelar con los casos de uso, sin HTTP; sin tráfico de la API sobre esos lotes después',
      worker: 'node dist/worker.js con vencimientos y avisos; sano = latido reciente y /health worker ok antes del plazo; '
        + 'antes de fijar el plazo vacía lo pendiente de corridas anteriores, así que mide sin otro trabajo',
      metric: 'outbox_events.processed_at (offer_expired) − waitlist_entries.offer_expires_at; percentil por rango más cercano',
      clocks: 'offer_expires_at usa el reloj de PostgreSQL y processed_at el del host del worker; se mide la diferencia' },
    expected: { perOffer: 'vence una vez (un registro lot_expiry y un evento offer_expired) y genera un aviso',
      countersPerLot: { f: 1, o: 0, r: 0, e: 0, x: 0 },
      goal: 'P95 ≤ 30 s: se informa cumple o no cumple; no hace fallar el script' },
  }, async record => {
    const holderId = await seedUser('vencidas-titular')
    const lots = await makeLots(100, 1, 'vencidas')
    const waiters = (await database.query(`INSERT INTO users(email)
      SELECT format('k039-vencidas-%s-%s@example.invalid', g, gen_random_uuid()) FROM generate_series(1, 100) g
      RETURNING id::text`)).rows.map(row => row.id)
    const entries = []
    for (let i = 0; i < lots.length; i += 10) {
      entries.push(...await Promise.all(lots.slice(i, i + 10).map(async (lotId, j) => {
        const waiterId = waiters[i + j]
        const held = await discovery.reserve({ userId: holderId }, lotId, 1, randomUUID())
        const entry = await waitlist.join({ userId: waiterId }, lotId, 1, randomUUID())
        await reservations.cancel({ userId: holderId }, held.id)
        return entry.id
      })))
    }
    const offered = (await database.query(`SELECT count(*)::int AS n FROM waitlist_entries WHERE public_id = ANY($1::uuid[])
      AND status = 'offered' AND offered_quantity = 1`, [entries])).rows[0].n
    assert.equal(offered, 100, 'cada lote debe quedar con una oferta vigente')
    const dueLots = async () => (await database.query(`SELECT count(*)::int AS n FROM (${DUE_LOTS}) d`)).rows[0].n
    const pendingEvents = async () => (await database.query(`SELECT count(*)::int AS n FROM outbox_events WHERE status = 'pending'`)).rows[0].n
    record.observed.backlogBeforeWorker = { dueLots: await dueLots(), pendingEvents: await pendingEvents() }

    const { rows: [{ at: spawnedAt }] } = await database.query('SELECT clock_timestamp() AS at')
    const { PHOTO_STORAGE: _storage, WORKER_EXPIRIES: _expiries, ...workerEnvironment } = process.env
    const child = spawn(process.execPath, ['dist/worker.js'], { cwd: apiDirectory, env: workerEnvironment, stdio: ['ignore', 'pipe', 'pipe'] })
    const running = { child, output: '', exit: once(child, 'exit') }
    worker = running
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { running.output += chunk })
    const alive = () => child.exitCode === null && child.signalCode === null
    await until('primer ciclo del worker', async () => (await database.query(
      'SELECT last_cycle_at >= $1 AS fresh FROM worker_heartbeat', [spawnedAt])).rows[0]?.fresh === true, 30_000)
    // El worker vacía primero lo pendiente: avisos de los casos anteriores y, en una base ya usada,
    // los lotes de corridas anteriores que cerraron. Así la medida empieza sin otro trabajo.
    await until('worker sin vencimientos ni avisos pendientes', async () => await dueLots() === 0 && await pendingEvents() === 0, 300_000)
    const healthy = await health()
    record.statusCounts = tally([healthy], result => result.status === 200 && result.body.worker === 'ok' ? '200 /health worker ok' : null)
    assert.ok(alive() && healthy.body.worker === 'ok', 'el worker debe estar sano antes del plazo')

    // Diferencia entre el reloj de PostgreSQL y el del host, con el menor RTT de cinco lecturas.
    let clock = null
    for (let i = 0; i < 5; i++) {
      const sent = Date.now()
      const { rows: [{ at }] } = await database.query('SELECT clock_timestamp() AS at')
      const received = Date.now()
      if (!clock || received - sent < clock.rttMs) clock = { rttMs: received - sent, dbMinusHostMs: Math.round(at.getTime() - (sent + received) / 2) }
    }
    const { rows: [{ deadline }] } = await database.query(`SELECT date_trunc('milliseconds', clock_timestamp() + interval '5 seconds') AS deadline`)
    const moved = await database.query(`UPDATE waitlist_entries SET offer_expires_at = $1
      WHERE public_id = ANY($2::uuid[]) AND status = 'offered'`, [deadline, entries])
    assert.equal(moved.rowCount, 100)
    const { rows: [beforeDeadline] } = await database.query(`SELECT clock_timestamp() < $1 AS early,
      (SELECT last_cycle_at > clock_timestamp() - interval '60 seconds' FROM worker_heartbeat) AS beating`, [deadline])
    assert.ok(beforeDeadline.early && beforeDeadline.beating && alive(), 'el worker debe seguir sano al fijar el plazo')

    const processed = async () => (await database.query(`SELECT count(*)::int AS n FROM outbox_events e
      JOIN waitlist_entries w ON w.id = e.subject_id WHERE e.event_type = 'offer_expired' AND e.status = 'processed'
        AND w.public_id = ANY($1::uuid[])`, [entries])).rows[0].n
    await until('avisos de las 100 ofertas vencidas', async () => await processed() === 100, 5_000 + 120_000)
    const rows = (await database.query(`SELECT w.public_id::text AS id, l.public_id::text AS lot, w.status, w.offer_expires_at,
        w.ended_at, e.created_at, e.processed_at, e.status AS event_status,
        (SELECT count(*)::int FROM outbox_events x WHERE x.subject_id = w.id AND x.event_type = 'offer_expired') AS events,
        (SELECT count(*)::int FROM notifications n WHERE n.event_id = e.id) AS notices
      FROM waitlist_entries w JOIN lots l ON l.id = w.lot_id
      LEFT JOIN outbox_events e ON e.subject_id = w.id AND e.event_type = 'offer_expired'
      WHERE w.public_id = ANY($1::uuid[])`, [entries])).rows
    const { rows: [{ beating: stillBeating }] } = await database.query(
      `SELECT last_cycle_at > clock_timestamp() - interval '60 seconds' AS beating FROM worker_heartbeat`)
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    const [code, signal] = await running.exit
    clearTimeout(timer)
    worker = null

    // El worker escribe una línea JSON por evento; las líneas de arranque y parada son texto.
    const logged = running.output.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    const expiries = new Map()
    for (const event of logged) {
      if (event.event === 'lot_expiry' && lots.includes(event.lotId)) expiries.set(event.lotId, [...(expiries.get(event.lotId) ?? []), event])
    }
    const broken = rows.filter(row => row.status !== 'expired' || row.events !== 1 || row.notices !== 1
      || row.event_status !== 'processed' || row.ended_at?.getTime() !== deadline.getTime()).map(row => row.id)
    const registeredOnce = lots.filter(lotId => expiries.get(lotId)?.length === 1 && expiries.get(lotId)[0].closedEntries === 1).length
    const delays = rows.filter(row => row.processed_at).map(row => row.processed_at.getTime() - row.offer_expires_at.getTime())
    // processed_at sale del host y offer_expires_at de PostgreSQL: sumar la diferencia lleva todo al reloj de la base.
    const corrected = delays.map(delay => delay + clock.dbMinusHostMs)
    const metric = summary(delays)
    const worst = Math.max(metric.p95, summary(corrected).p95)
    const stored = await lotState(lots)
    const unreconciledLots = await unreconciled(lots)
    Object.assign(record.observed, {
      offers: rows.length, expiredOnceWithOneNotice: rows.length - broken.length, brokenOffers: broken,
      lotExpiryRegisteredOnce: registeredOnce, workerHealthyBeforeDeadline: true, workerHealthyAfter: stillBeating,
      workerExit: { code, signal }, workerErrors: logged.filter(event => event.event === 'worker_error').length,
      lotsWithExpectedCounters: lots.filter(lotId => isDeepStrictEqual(stored.get(lotId).counters, { f: 1, o: 0, r: 0, e: 0, x: 0 })).length,
      unreconciledLots,
      metric: { indicator: 'Tareas vencidas', goal: 'P95 ≤ 30 s',
        definition: { delayMs: 'processed_at del evento offer_expired (aviso persistido) − offer_expires_at',
          registeredMs: 'created_at del evento (reloj de PostgreSQL tras el bloqueo, estado persistido) − offer_expires_at' },
        delayMs: metric, delayCorrectedMs: summary(corrected),
        registeredMs: summary(rows.filter(row => row.created_at).map(row => row.created_at.getTime() - row.offer_expires_at.getTime())),
        clock, decidedWith: 'el mayor P95 entre el valor directo y el corregido por reloj',
        // Sin las 100 demoras la meta queda sin medir, no cumplida.
        meetsGoal: delays.length === rows.length && rows.length >= 100 ? worst <= EXPIRY_GOAL_MS : null },
      delaysMs: [...delays].sort((a, b) => a - b),
    })
    assert.deepEqual(broken, [], 'cada oferta vence una vez, con ended_at = plazo y un solo aviso procesado')
    assert.equal(registeredOnce, lots.length, 'el worker registra cada lote una sola vez')
    assert.equal(record.observed.lotsWithExpectedCounters, lots.length)
    assert.deepEqual(unreconciledLots, [])
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, 'SIGTERM termina el worker de forma ordenada')
    assert.equal(record.observed.workerErrors, 0)
    const seconds = value => `${(value / 1000).toFixed(1)} s`
    const verdict = { true: 'cumple', false: 'no cumple', null: 'sin medir' }[record.observed.metric.meetsGoal]
    return `${rows.length} ofertas vencidas una vez con un aviso; demora p50 ${seconds(metric.p50)}, p95 ${seconds(metric.p95)}, `
      + `max ${seconds(metric.max)} (meta P95 ≤ 30 s: ${verdict})`
  })

  // --- Conciliación global de todos los lotes de la base, también los de corridas anteriores.
  const allLots = (await database.query('SELECT count(*)::int AS n FROM lots')).rows[0].n
  const globalUnreconciled = await unreconciled()
  const consistency = { lots: allLots, rule: INVENTORY_RULE, unreconciledLots: globalUnreconciled, pass: globalUnreconciled.length === 0 }
  console.log(`${consistency.pass ? 'OK' : 'FAIL'}: conciliación global de ${allLots} lotes (${INVENTORY_RULE})`)

  const finishedAt = new Date()
  const expiredTasks = cases.find(item => item.name === 'Tareas vencidas')?.observed.metric ?? null
  const goal = expiredTasks ? { indicator: expiredTasks.indicator, goal: expiredTasks.goal, p95Ms: expiredTasks.delayMs.p95,
    meetsGoal: expiredTasks.meetsGoal } : { indicator: 'Tareas vencidas', goal: 'P95 ≤ 30 s', p95Ms: null, meetsGoal: null }
  const report = { card: 'K039', script: 'api/scripts/test-integrity.mjs', database: databaseName,
    startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt - startedAt, environment,
    cases, consistency, summary: { cases: cases.length, passed: cases.filter(item => item.pass).length,
      unexpectedResponses: cases.reduce((sum, item) => sum + totalOf(item.statusCounts.unexpected), 0),
      casesWithoutExpectedResponses: cases.filter(item => !item.expectedResponsesMet).map(item => item.name),
      contractViolations: cases.reduce((sum, item) => sum + item.contractViolations.length, 0),
      goals: [goal] } }
  const directory = `${apiDirectory}.k039-results/${databaseName}`
  mkdirSync(directory, { recursive: true })
  writeFileSync(`${directory}/integrity.json`, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Resultados en api/.k039-results/${databaseName}/integrity.json`)
  const verdict = { true: 'cumple', false: 'no cumple', null: 'sin medir' }[goal.meetsGoal]
  const failed = cases.filter(item => !item.pass)
  if (failed.length || !consistency.pass) {
    console.error(`FAIL K039: ${failed.length} de ${cases.length} casos fallaron${consistency.pass ? '' : ' y la conciliación global no cuadra'}`)
    process.exitCode = 1
  } else {
    const { unexpectedResponses } = report.summary
    console.log(`PASS K039: ${cases.length} casos de integridad con PostgreSQL real, API real y worker real; `
      + (unexpectedResponses ? `${unexpectedResponses} respuestas inesperadas (no deciden pass; ver statusCounts.unexpected)`
        : '0 respuestas inesperadas') + `; meta de tareas vencidas (P95 ≤ 30 s): ${verdict}`)
  }
} finally {
  if (worker) { worker.child.kill('SIGKILL'); await worker.exit.catch(() => {}) }
  await blocker.query('ROLLBACK').catch(() => {})
  await new Promise(resolve => server.close(resolve))
  await api.close()
  await pool.end()
  await Promise.all([database, observer, blocker].map(client => client.end().catch(() => {})))
}
