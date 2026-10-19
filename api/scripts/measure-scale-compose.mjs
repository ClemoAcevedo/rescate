// K032: base aislada con la semilla de escala, planes reales y p50/p95 con k6 en Docker.
// No migra ni siembra la base de desarrollo. Los resultados quedan en api/.k032-results/<base>/.
// WARMUP_SECONDS y MEASURED_SECONDS ajustan la duración (por omisión 30 s y 120 s).
import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'
import { seedScale } from './seed-scale.mjs'
import { explainScale, summarize } from './explain-scale.mjs'

const K6_IMAGE = 'grafana/k6:1.3.0'
const root = fileURLToPath(new URL('../../', import.meta.url))
const api = fileURLToPath(new URL('../', import.meta.url))
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const compose = (...args) => docker('compose', ...args)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const output = async (command, args) => (await promisify(execFile)(command, args, { encoding: 'utf8' })).stdout.trim()

async function freePort() {
  const server = createServer().listen(0)
  await new Promise(resolve => server.once('listening', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

// CPU y memoria de PostgreSQL (contenedor) y de la API (proceso) cada 2 s mientras corre k6.
// Las esperas por bloqueo se cuentan cada 250 ms: una reserva retiene el lote unos milisegundos.
function sampleResources(apiPid, container, db) {
  const samples = []
  const waits = []
  const locks = setInterval(() => {
    db.query(`SELECT count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS waiting,
        count(*) FILTER (WHERE state = 'active')::int AS active FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`).then(r => waits.push(r.rows[0]), () => {})
  }, 250)
  const timer = setInterval(async () => {
    try {
      const [cpu, memory] = (await output('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}};{{.MemUsage}}', container])).split(';')
      const [apiCpu, apiRss] = (await output('ps', ['-o', '%cpu=,rss=', '-p', String(apiPid)])).split(/\s+/)
      samples.push({ dbCpu: parseFloat(cpu), dbMemory: memory.split('/')[0].trim(), apiCpu: Number(apiCpu), apiRssMb: Math.round(Number(apiRss) / 1024) })
    } catch { /* una muestra perdida no invalida la medición */ }
  }, 2000)
  return { stop: () => {
    clearInterval(timer); clearInterval(locks)
    return { samples, lockWaits: { max: Math.max(0, ...waits.map(w => w.waiting)),
      samplesWithWait: waits.filter(w => w.waiting > 0).length, samples: waits.length,
      maxActive: Math.max(0, ...waits.map(w => w.active)) } }
  } }
}

function peak(samples, key) {
  const values = samples.map(sample => sample[key]).filter(Number.isFinite)
  return values.length ? { avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length), max: Math.max(...values) } : null
}

let database
let server
try {
  const user = compose('exec', '-T', 'db', 'printenv', 'POSTGRES_USER').trim()
  const password = compose('exec', '-T', 'db', 'printenv', 'POSTGRES_PASSWORD').trim()
  const address = compose('port', 'db', '5432').trim()
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Se requiere el puerto loopback de K006')
  database = `rescate_k032_test_${Date.now()}_${randomBytes(4).toString('hex')}`
  compose('exec', '-T', 'db', 'createdb', '-U', user, '--template=template0', database)
  const url = new URL(`postgresql://${address}/${database}`)
  url.username = user
  url.password = password
  console.log(`Base dedicada K032 creada: ${database}`)
  execFileSync(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up'], {
    cwd: api, stdio: 'ignore', env: { ...process.env, DATABASE_URL: url.href },
  })
  const results = `${api}.k032-results/${database}`
  mkdirSync(results, { recursive: true })
  const pickupKey = randomBytes(32)
  const environment = { RESCATE_ALLOWED_ORIGINS: 'https://localhost:5173', CSRF_SIGNING_KEY: randomBytes(32).toString('base64'),
    PICKUP_CODE_KEY: pickupKey.toString('base64') }

  let started = Date.now()
  const seed = await seedScale(url.href, pickupKey, line => console.log(`  ${line}`))
  console.log(`Semilla en ${((Date.now() - started) / 1000).toFixed(1)} s:`, seed.counts)
  writeFileSync(`${results}/seed.json`, JSON.stringify(seed))

  const plans = await explainScale(url.href, seed, environment)
  writeFileSync(`${results}/plans.txt`, plans.map(({ label, sql, plan }) => `## ${label}\n${sql}\n\n${plan}\n`).join('\n'))
  console.log('\nPlanes (tiempo de ejecución en PostgreSQL; Seq Scan de más de 1000 filas):')
  for (const { label, sql, time, scans } of summarize(plans)) {
    if (time >= 1 || scans.length) console.log(`  ${label.padEnd(34)} ${time.toFixed(2).padStart(8)} ms  ${scans.join(', ')}  ${sql.slice(0, 70)}…`)
  }

  const db = new pg.Client({ connectionString: url.href })
  await db.connect()
  const sizes = (await db.query(`SELECT c.relname AS table, pg_size_pretty(pg_table_size(c.oid)) AS data,
      pg_size_pretty(pg_indexes_size(c.oid)) AS indexes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8`)).rows
  const postgres = (await db.query('SELECT version()')).rows[0].version.split(' on ')[0]
  const total = (await db.query('SELECT pg_size_pretty(pg_database_size(current_database())) size')).rows[0].size

  const port = await freePort()
  server = spawn(process.execPath, ['dist/index.js'], { cwd: api, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, ...environment, DATABASE_URL: url.href, PORT: String(port) } })
  for (let attempt = 0; ; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false)) break
    if (attempt > 50) throw new Error('La API no respondió /health')
    await sleep(200)
  }

  console.log(`\nk6 (${K6_IMAGE}): ${process.env.WARMUP_SECONDS ?? 30} s de preparación y ${process.env.MEASURED_SECONDS ?? 120} s medidos`)
  const container = compose('ps', '-q', 'db').trim()
  const sampler = sampleResources(server.pid, container, db)
  started = Date.now()
  const k6 = spawn('docker', ['run', '--rm', '--user', `${process.getuid()}:${process.getgid()}`,
    '--add-host=host.docker.internal:host-gateway', '-v', `${api}load:/scripts:ro`, '-v', `${results}:/results`,
    '-e', 'SEED=/results/seed.json', '-e', `API_URL=http://host.docker.internal:${port}`,
    '-e', `ORIGIN=${environment.RESCATE_ALLOWED_ORIGINS}`,
    ...['WARMUP_SECONDS', 'MEASURED_SECONDS'].flatMap(name => process.env[name] ? ['-e', `${name}=${process.env[name]}`] : []),
    K6_IMAGE, 'run', '--quiet', '/scripts/k032.js'], { stdio: 'inherit' })
  const k6Code = await new Promise(resolve => k6.once('exit', resolve))
  const { samples, lockWaits } = sampler.stop()
  await db.end()

  const resources = {
    commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    system: `${os.type()} ${os.release()}`, cpu: `${os.cpus()[0].model} × ${os.cpus().length}`,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3), node: process.version, postgres, k6: K6_IMAGE,
    docker: docker('info', '--format', '{{.OperatingSystem}} {{.ServerVersion}}').trim(),
    apiPool: 8, loadGenerator: 'mismo equipo que API y PostgreSQL', seconds: Math.round((Date.now() - started) / 1000),
    database: total, sizes, dbCpuPercent: peak(samples, 'dbCpu'), apiCpuPercent: peak(samples, 'apiCpu'),
    apiRssMb: peak(samples, 'apiRssMb'), dbMemory: samples.at(-1)?.dbMemory, samples: samples.length, lockWaits,
  }
  writeFileSync(`${results}/resources.json`, JSON.stringify(resources, null, 2))
  console.log('\nRecursos:', JSON.stringify({ ...resources, sizes: undefined }))
  console.log('Tablas:', sizes.map(s => `${s.table} ${s.data} + ${s.indexes}`).join(' · '))
  console.log(`\nResultados en api/.k032-results/${database}/ (seed.json contiene sesiones locales).`)
  console.log(`Base de prueba conservada: ${database}. No se alteró la base de desarrollo.`)
  if (k6Code !== 0) {
    console.error(k6Code === 99 ? 'k6: algún umbral del anexo H no se cumplió.' : `k6 terminó con código ${k6Code}.`)
    process.exitCode = 1
  }
} catch (error) {
  // Evitar errores de subprocesos que puedan contener URL/credenciales.
  console.error(`FAIL K032 medición. ${error instanceof Error && !/postgres(ql)?:\/\//.test(error.message) ? error.message : 'Revisar salida.'}${database ? ` Base prevista: ${database}.` : ''}`)
  process.exitCode = 1
} finally {
  server?.kill('SIGTERM')
}
