// K022/K025: misma base aislada, primero con worker de fotos y después detenido.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = fileURLToPath(new URL('../../', import.meta.url))
const api = fileURLToPath(new URL('../', import.meta.url))
const docker = (...args) => execFileSync('docker', ['compose', ...args], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
})
let database
let observer
let directory
let worker
let workerExit
let workerOutput = ''
let workerFailed = false
let workerStopRequested = false
let suite
let interrupted = false
function interrupt(code) {
  interrupted = true
  process.exitCode = code
  suite?.kill('SIGTERM')
}
const onInterrupt = () => interrupt(130)
const onTerminate = () => interrupt(143)
process.once('SIGINT', onInterrupt)
process.once('SIGTERM', onTerminate)
const workerRunning = () => worker && !workerFailed && worker.exitCode === null && worker.signalCode === null

async function stopWorker() {
  if (!worker) return
  if (workerRunning()) {
    workerStopRequested = true
    worker.kill('SIGTERM')
  }
  assert.ok(workerStopRequested, 'El worker no debe terminar antes de solicitar su parada')
  const timeout = setTimeout(() => worker.kill('SIGKILL'), 10_000)
  try {
    const result = await workerExit
    assert.deepEqual(result, { code: 0, signal: null }, 'El worker debe terminar limpiamente con SIGTERM')
  } finally { clearTimeout(timeout) }
}

async function runSuite(env) {
  assert.equal(interrupted, false, 'La ejecución fue interrumpida')
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/test-reservations.mjs'], {
      cwd: api, stdio: 'inherit', env,
    })
    suite = child
    const timeout = setTimeout(() => child.kill('SIGTERM'), 180_000)
    child.once('error', () => { clearTimeout(timeout); suite = null; reject(new Error('No se pudo iniciar la suite')) })
    child.once('exit', (code, signal) => { clearTimeout(timeout); suite = null; resolve({ code, signal }) })
  })
  assert.deepEqual(result, { code: 0, signal: null }, 'La suite debe finalizar sin errores')
}

try {
  const user = docker('exec', '-T', 'db', 'printenv', 'POSTGRES_USER').trim()
  const password = docker('exec', '-T', 'db', 'printenv', 'POSTGRES_PASSWORD').trim()
  const address = docker('port', 'db', '5432').trim()
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Se requiere el puerto loopback de K006')
  database = `rescate_k022_test_${Date.now()}_${randomBytes(4).toString('hex')}`
  docker('exec', '-T', 'db', 'createdb', '-U', user, '--template=template0', database)
  const url = new URL(`postgresql://${address}/${database}`)
  url.username = user
  url.password = password
  console.log(`Base dedicada K022 creada: ${database}`)
  const env = { ...process.env, DATABASE_URL: url.href }
  execFileSync(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up'], {
    cwd: api, stdio: 'ignore', env,
  })
  execFileSync('npm', ['run', 'build'], { cwd: api, stdio: 'inherit', env })
  observer = new pg.Client({ connectionString: url.href, statement_timeout: 5000, connectionTimeoutMillis: 5000 })
  await observer.connect()
  directory = await mkdtemp(join(tmpdir(), 'rescate-k025-'))
  const workerName = `k025-worker-${randomBytes(4).toString('hex')}`
  const workerUrl = new URL(url)
  workerUrl.searchParams.set('application_name', workerName)
  worker = spawn(process.execPath, ['dist/worker.js'], {
    cwd: api, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, DATABASE_URL: workerUrl.href, PHOTO_STORAGE: 'local', PHOTO_LOCAL_DIR: directory },
  })
  workerExit = new Promise(resolve => {
    worker.once('error', () => { workerFailed = true; resolve({ code: null, signal: 'spawn-error' }) })
    worker.once('exit', (code, signal) => resolve({ code, signal }))
  })
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', chunk => { workerOutput += chunk })
  const connections = async () => (await observer.query(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND application_name = $1`, [workerName])).rows[0].n
  let connected = false
  for (let attempt = 0; attempt < 100 && !interrupted && workerRunning() && !connected; attempt++) {
    connected = await connections() > 0
    if (!connected) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(connected && workerRunning(), 'El worker real debe conectarse a la base dedicada')
  assert.match(workerOutput, /Worker iniciado: validación y limpieza de fotos/)
  console.log('K025 fase 1: worker de fotos activo y conectado a PostgreSQL')
  await runSuite(env)
  assert.ok(workerRunning() && await connections() > 0, 'El worker debe seguir conectado al terminar la primera fase')
  await stopWorker()
  assert.equal(await connections(), 0, 'SIGTERM debe cerrar las conexiones del worker')
  assert.doesNotMatch(workerOutput, /photo_worker_error|database_idle_connection_lost/)
  console.log('K025 fase 2: worker detenido con SIGTERM; se repite la suite en la misma base con nuevos datos')
  await runSuite(env)
  assert.equal(await connections(), 0, 'El worker debe continuar detenido durante la segunda fase')
  console.log('PASS K025: mismas comprobaciones con worker activo y detenido; cero conexiones del worker')
  console.log(`Base de prueba conservada: ${database}. No se alteró la base de desarrollo.`)
} catch {
  // Evitar errores de subprocesos que puedan contener URL/credenciales.
  console.error(`FAIL K022/K025. Revisar salida de pruebas.${database ? ` Base prevista: ${database}.` : ''}`)
  process.exitCode ??= 1
} finally {
  try { await stopWorker() } catch { console.error('FAIL al detener el worker de prueba'); process.exitCode = 1 }
  if (observer) await observer.end().catch(() => {})
  if (directory) await rm(directory, { recursive: true, force: true })
  process.removeListener('SIGINT', onInterrupt)
  process.removeListener('SIGTERM', onTerminate)
}
