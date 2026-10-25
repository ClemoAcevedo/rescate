// K036: registros por solicitud, salud y tareas pendientes contra PostgreSQL real y un
// proceso real del worker, que se mata con kill -9 para detectarlo detenido.
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import net from 'node:net'
import { promisify } from 'node:util'
import pg from 'pg'
import { createApi } from '../dist/composition.js'
import { EXPIRY_LIMITS } from '../dist/application/expiries/use-cases.js'
import { createOperations } from '../dist/infrastructure/postgres/operations.js'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_k036_test_/.test(new URL(connectionString).pathname.slice(1)),
  'Se requiere base de prueba aislada K036')
const keys = { RESCATE_ALLOWED_ORIGINS: 'https://localhost:5173', CSRF_SIGNING_KEY: randomBytes(32).toString('base64'),
  PICKUP_CODE_KEY: randomBytes(32).toString('base64') }
const lines = []
const api = createApi({ ...process.env, ...keys }, event => lines.push(JSON.stringify(event)))
const server = api.app.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
const database = new pg.Client({ connectionString })
const pool = new pg.Pool({ connectionString, max: 1 })
const operations = createOperations(pool, EXPIRY_LIMITS.maxAttempts)
let checks = 0
const ok = label => console.log(`OK ${++checks}: ${label}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(label, condition, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await condition()) return; await sleep(100) }
  assert.fail(`Tiempo agotado: ${label}`)
}
const health = async (url = base) => { const response = await fetch(`${url}/health`); return [response.status, await response.json()] }
const events = () => lines.map(line => JSON.parse(line))

let worker
function startWorker() {
  const { PHOTO_STORAGE: _storage, WORKER_EXPIRIES: _expiries, ...env } = process.env
  const child = spawn(process.execPath, ['dist/worker.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  worker = { child, output: '' }
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { worker.output += chunk })
  return worker
}
async function stopWorker(signal) {
  const exited = once(worker.child, 'exit')
  worker.child.kill(signal)
  await exited
}
const workerEvents = () => worker.output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))

try {
  await database.connect()
  const establishment = (await database.query(`INSERT INTO establishments (name, address, latitude, longitude, time_zone)
    VALUES ('K036 Panadería', 'Santiago', -33.45, -70.66, 'America/Santiago') RETURNING id`)).rows[0].id
  const lot = async endsIn => (await database.query(`INSERT INTO lots (establishment_id, description,
      category, quantity, address, latitude, longitude, time_zone, pickup_starts_at, pickup_ends_at, status, published_at)
    VALUES ($1, 'Pan del día K036', 'Panadería', 2, 'Santiago Centro', -33.45, -70.66, 'America/Santiago',
      now() - interval '3 hours', now() + $2::interval, 'published', now() - interval '4 hours')
    RETURNING public_id::text AS id`, [establishment, endsIn])).rows[0].id

  // --- 1. Sin latido, la base responde y el worker figura detenido.
  assert.deepEqual(await health(), [200, { status: 'ok', database: 'ok', worker: 'stopped' }])
  ok('salud sin worker: 200, base ok, worker detenido')

  // --- 2. El worker escribe su latido y registra la demora de cada cola.
  startWorker()
  await until('latido del worker', async () => (await health())[1].worker === 'ok')
  await until('demora registrada', async () => workerEvents().filter(event => event.event === 'worker_backlog').length === 3)
  assert.deepEqual(workerEvents().filter(event => event.event === 'worker_backlog').map(event => event.queue),
    ['expiries', 'notifications', 'photos'])
  ok('worker iniciado: salud con worker ok y worker_backlog por cola (vencimientos, avisos, fotos)')

  // --- 3. Una solicitud deja una línea con la plantilla de la ruta, estado y duración.
  const open = await lot('2 hours')
  assert.equal((await fetch(`${base}/public/lots/${open}?email=ana@example.invalid`)).status, 200)
  const served = events().find(event => event.event === 'request' && event.status === 200)
  assert.deepEqual(Object.keys(served), ['event', 'requestId', 'operation', 'status', 'durationMs', 'completed'])
  assert.equal(served.operation, 'GET /public/lots/:lotId')
  ok(`solicitud registrada: ${served.operation} ${served.status} en ${served.durationMs} ms, sin el ID ni la consulta`)

  // --- 4. Un fallo real (statement_timeout bajo un bloqueo) se correlaciona con su solicitud.
  await database.query('BEGIN')
  await database.query('LOCK TABLE lots IN ACCESS EXCLUSIVE MODE')
  const blocked = await fetch(`${base}/public/lots/${open}`)
  await database.query('ROLLBACK')
  assert.equal(blocked.status, 503)
  const failure = events().find(event => event.event === 'request_failed')
  const request = events().find(event => event.event === 'request' && event.requestId === failure.requestId)
  assert.deepEqual([failure.code, request.operation, request.status], ['57014', 'GET /public/lots/:lotId', 503])
  assert.ok(request.durationMs >= 4000)
  ok(`fallo correlacionado: request_failed ${failure.code} y la solicitud ${request.operation} 503 de ${request.durationMs} ms comparten ${failure.requestId}`)

  // --- 5. kill -9: el latido deja de avanzar y la salud informa el worker detenido.
  await stopWorker('SIGKILL')
  assert.equal((await health())[1].worker, 'ok')
  await database.query("UPDATE worker_heartbeat SET last_cycle_at = last_cycle_at - interval '61 seconds'")
  assert.deepEqual(await health(), [200, { status: 'ok', database: 'ok', worker: 'stopped' }])
  ok('worker muerto con kill -9: pasado el plazo de 60 s sin latido, la salud lo informa detenido')

  // --- 6. Con el worker detenido, la consulta de operación muestra demora y tareas en error.
  const max = EXPIRY_LIMITS.maxAttempts
  const due = await lot('-1 hour')
  const exhausted = await lot('-2 hours')
  const inFlight = await lot('-150 minutes')
  await database.query('UPDATE lots SET expiry_attempts = $2 WHERE public_id = $1', [exhausted, max])
  // Quinto intento en curso: concesión vigente, todavía puede registrarse. No es un error.
  await database.query(`UPDATE lots SET expiry_attempts = $2, expiry_claimed_until = now() + interval '1 minute'
    WHERE public_id = $1`, [inFlight, max])
  // Aviso con los intentos agotados y sin concesión: el reclamo lo vuelve a tomar, es pendiente.
  const recipient = (await database.query("INSERT INTO users (email) VALUES ('k036-aviso@example.invalid') RETURNING id")).rows[0].id
  const stranded = (await database.query(`INSERT INTO outbox_events (event_type, subject_id, recipient_user_id, payload,
      created_at, attempts, available_at)
    VALUES ('offer_issued', 1, $1, '{}', now() - interval '10 minutes', 5, now() - interval '10 minutes')
    RETURNING id::text`, [recipient])).rows[0].id
  const unclaimed = (await operations.readBacklog())[1]
  assert.deepEqual([unclaimed.queue, unclaimed.pending, unclaimed.failed], ['notifications', 1, 0])
  // Su worker murió en el quinto intento: concesión vencida, nadie lo reintenta.
  await database.query("UPDATE outbox_events SET claimed_until = now() - interval '1 minute' WHERE id = $1", [stranded])
  const [running, notices] = await operations.readBacklog()
  assert.deepEqual([running.pending, running.failed, notices.pending, notices.failed], [2, 1, 0, 1])
  // Vencida la concesión del quinto intento, el lote pasa a error.
  await database.query("UPDATE lots SET expiry_claimed_until = now() - interval '1 second' WHERE public_id = $1", [inFlight])
  const [expiries] = await operations.readBacklog()
  assert.deepEqual([expiries.queue, expiries.pending, expiries.failed], ['expiries', 1, 2])
  assert.ok(expiries.delaySeconds >= 3600 && expiries.delaySeconds < 3700)
  assert.deepEqual((await operations.listFailedTasks()).map(task => [task.queue, task.id, task.attempts, task.code]),
    [['expiries', exhausted, max, null], ['expiries', inFlight, max, null], ['notifications', stranded, 5, 'LEASE_EXPIRED']])
  const report = execFileSync(process.execPath, ['scripts/ops-status.mjs'], { encoding: 'utf8' })
  assert.match(report, /Worker: DETENIDO: sin ciclo exitoso en 60 s/)
  assert.ok(report.includes(exhausted) && report.includes(inFlight) && report.includes('LEASE_EXPIRED'))
  assert.ok(!report.includes(due) && !/postgres(ql)?:/.test(report))
  ok(`ops:status: worker detenido, 1 vencimiento con ${expiries.delaySeconds} s de demora; en error 2 lotes y 1 aviso abandonado; el quinto intento en curso y el aviso sin concesión cuentan como pendientes`)

  // --- 7. Reiniciado, el worker registra lo pendiente; el lote en error sigue para revisión.
  startWorker()
  await until('vencimiento registrado', async () => workerEvents().some(event => event.event === 'lot_expiry' && event.lotId === due))
  await until('latido nuevo', async () => (await health())[1].worker === 'ok')
  const [after] = await operations.readBacklog()
  assert.deepEqual([after.pending, after.delaySeconds, after.failed], [0, null, 2])
  await stopWorker('SIGTERM')
  assert.doesNotMatch(worker.output, /worker_error|postgres(ql)?:/)
  ok('worker reiniciado: registra el vencimiento atrasado, vuelve el latido y el lote en error queda para revisión')

  // --- 8. Sin base, base colgada y base sin migrar: la salud responde sin detalles de la conexión.
  /** `requests` llamadas simultáneas y después `later` llamadas de a una, contra otra API. */
  async function healthWith(databaseUrl, requests = 1, later = 0) {
    const other = createApi({ ...process.env, ...keys, DATABASE_URL: databaseUrl }, () => {})
    const otherServer = other.app.listen(0, '127.0.0.1')
    await once(otherServer, 'listening')
    const url = `http://127.0.0.1:${otherServer.address().port}`
    const started = Date.now()
    const results = await Promise.all(Array.from({ length: requests }, () => health(url)))
    for (let index = 0; index < later; index++) results.push(await health(url))
    const seconds = (Date.now() - started) / 1000
    otherServer.close()
    await other.close()
    return { results, seconds }
  }
  const unavailable = [503, { status: 'unavailable', database: 'unavailable', worker: 'unknown' }]
  const refused = await healthWith('postgresql://k036:secreto-k036@127.0.0.1:9/nada')
  assert.deepEqual(refused.results, [unavailable])
  // Acepta la conexión y nunca contesta: la salud corta a los 3 s y 20 llamadas simultáneas
  // abren una sola conexión.
  const sockets = []
  const silent = net.createServer(socket => sockets.push(socket)).listen(0, '127.0.0.1')
  await once(silent, 'listening')
  const silentUrl = `postgresql://k036:secreto-k036@127.0.0.1:${silent.address().port}/nada`
  const hung = await healthWith(silentUrl, 20, 1)
  assert.deepEqual(hung.results, Array(21).fill(unavailable))
  assert.ok(hung.seconds >= 4.9 && hung.seconds < 7.5, `La salud colgada tardó ${hung.seconds} s`)
  // La comprobación siguiente, ya vencida la respuesta anterior, espera la misma consulta.
  assert.equal(sockets.length, 1)
  // ops:status tampoco queda esperando: termina con código 1 y sin detalles de la conexión.
  const startedStatus = Date.now()
  const statusRun = (() => { try { execFileSync(process.execPath, ['scripts/ops-status.mjs'], { encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DATABASE_URL: silentUrl } }); return null } catch (error) { return error } })()
  for (const socket of sockets) socket.destroy()
  silent.close()
  assert.equal(statusRun?.status, 1)
  assert.match(statusRun.stderr, /^Base no disponible/)
  assert.ok(!/secreto-k036|127\.0\.0\.1/.test(`${statusRun.stdout}${statusRun.stderr}`))
  assert.ok(Date.now() - startedStatus < 10_000)
  // Base que responde la salud y después deja de contestar: ops:status corta igual. El proxy
  // descarta todo desde la segunda consulta (mensaje Parse, «P»).
  const target = new URL(connectionString)
  const stalled = []
  const stalling = net.createServer(client => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname)
    let parses = 0
    client.on('data', chunk => { if (parses > 1 || chunk[0] === 0x50 && ++parses > 1) return; upstream.write(chunk) })
    upstream.pipe(client)
    for (const socket of [client, upstream]) { socket.on('error', () => {}); stalled.push(socket) }
  }).listen(0, '127.0.0.1')
  await once(stalling, 'listening')
  const stallingUrl = new URL(connectionString); stallingUrl.host = `127.0.0.1:${stalling.address().port}`
  const startedStall = Date.now()
  // Asíncrono: el proxy vive en este proceso y execFileSync lo dejaría sin reenviar.
  const stallRun = await promisify(execFile)(process.execPath, ['scripts/ops-status.mjs'],
    { env: { ...process.env, DATABASE_URL: stallingUrl.href } }).then(() => null, error => error)
  const stallSeconds = (Date.now() - startedStall) / 1000
  for (const socket of stalled) socket.destroy()
  stalling.close()
  assert.equal(stallRun?.code, 1)
  assert.match(stallRun.stdout, /^Worker: /)
  assert.match(stallRun.stderr, /^Base sin respuesta/)
  assert.ok(!/postgres(ql)?:|127\.0\.0\.1/.test(`${stallRun.stdout}${stallRun.stderr}`))
  assert.ok(stallSeconds >= 5.5 && stallSeconds < 10, `ops:status colgado tardó ${stallSeconds} s`)
  // Base sin migrar (la de mantenimiento del mismo servidor): responde, sin latido que leer.
  const bare = new URL(connectionString); bare.pathname = '/postgres'
  assert.deepEqual((await healthWith(bare.href)).results, [[200, { status: 'ok', database: 'ok', worker: 'unknown' }]])
  ok(`salud sin base y con la base colgada (20 llamadas y una más tras vencer, 1 conexión; ops:status termina con código 1, también si la base calla tras la salud): 503 sin host ni credenciales; base sin migrar: 200 con worker desconocido`)

  // --- 9. Ninguna línea trae la URL con valores, correos ni la conexión.
  const all = lines.join('\n')
  for (const value of [open, 'ana@example.invalid', 'postgresql:']) assert.ok(!all.includes(value), 'Un registro contiene un valor de la solicitud')
  ok(`registros sin valores de la solicitud: ${lines.length} líneas revisadas`)
  console.log(`PASS K036: ${checks} grupos de registros, salud y tareas pendientes`)
} finally {
  if (worker && worker.child.exitCode === null && worker.child.signalCode === null) await stopWorker('SIGTERM')
  await database.query('ROLLBACK').catch(() => {})
  await database.end()
  await pool.end()
  server.close()
  await api.close()
}
