// K032/K039: ensayos de carga del anexo H (pp. 18–19) sobre la semilla de escala. Cada ensayo crea
// una base aislada rescate_k032_test_*, la migra, la siembra y analiza los planes; después levanta
// API y worker como contenedores de Compose de un solo uso contra esa base, corre k6 en la red del
// proyecto y verifica invariantes. No toca la base ni los servicios de desarrollo.
// Entorno: TRIALS (1), MIX (e2 o e3; e2), WARMUP_SECONDS (30) y MEASURED_SECONDS (120).
// Resultados en api/.k032-results/<corrida>/ensayo-N/ e informe en api/.k032-results/<corrida>/informe.md.
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'
import { seedScale } from './seed-scale.mjs'
import { explainScale, summarize } from './explain-scale.mjs'
import { remoteConfig, inspectGenerator, runRemoteK6 } from './support/remote-k6.mjs'

const K6_IMAGE = 'grafana/k6:1.3.0'
const ORIGIN = 'https://localhost:5173'
const OPS = { e2: ['busqueda', 'reserva', 'cancelacion'], e3: ['busqueda', 'chat', 'bandeja', 'reserva', 'cancelacion', 'mensaje'] }
const GOALS = { busqueda: 1000, reserva: 1500 }
// Los contenedores de cada corrida llevan esta etiqueta con el PID del proceso que los lanzó.
const OWNER_LABEL = 'rescate.k039.measure'
const root = fileURLToPath(new URL('../../', import.meta.url))
const api = fileURLToPath(new URL('../', import.meta.url))
const git = (...args) => execFileSync('git', ['-c', `safe.directory=${root.replace(/\/$/, '')}`, ...args], { cwd: root, encoding: 'utf8' }).trim()
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const compose = (...args) => docker('compose', ...args)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const output = async (command, args) => (await promisify(execFile)(command, args, { encoding: 'utf8' })).stdout.trim()
// Los mensajes de subprocesos pueden traer la URL de la base con su clave.
const safe = error => error instanceof Error && !/postgres(ql)?:\/\//.test(error.message) ? error.message : 'Revisar salida.'

const trials = Number(process.env.TRIALS ?? 1)
const mix = process.env.MIX ?? 'e2'
const warmup = Number(process.env.WARMUP_SECONDS ?? 30)
const measured = Number(process.env.MEASURED_SECONDS ?? 120)
const ops = OPS[mix]
let remote = null

async function waitFor(check, timeoutMs, message) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(100)) {
    const value = await check().catch(() => null)
    if (value) return value
  }
  throw new Error(message)
}

const health = async address => {
  const response = await fetch(`http://${address}/health`, { signal: AbortSignal.timeout(2000) })
  return { ...(await response.json()), http: response.status }
}

// Las líneas K036 no llevan secretos por diseño; igual se descarta cualquier URL de la base.
// Con el máximo por omisión (1 MiB) spawnSync corta la salida sin avisar: un ensayo de 720 s
// a 20 solicitudes/s deja más de 2 MB.
function logs(container) {
  const { stdout, stderr, error, status } = spawnSync('docker', ['logs', container], { encoding: 'utf8', maxBuffer: 256 * 2 ** 20 })
  if (error || status !== 0) throw new Error(`docker logs ${container} no terminó (${error?.code ?? `código ${status}`})`)
  return `${stdout}${stderr}`.split('\n').filter(line => line && !/postgres(ql)?:\/\//.test(line))
}

const megabytes = text => {
  const [, value, unit] = /([\d.]+)\s*([KMG]i?B|B)/.exec(text) ?? []
  return value ? Math.round(Number(value) * ({ B: 1 / 2 ** 20, KiB: 1 / 1024, kB: 1 / 1000, MiB: 1, MB: 1, GiB: 1024, GB: 1000 }[unit] ?? NaN)) : NaN
}

// CPU y memoria de cada contenedor cada 2 s mientras corre k6. Las esperas por bloqueo se cuentan
// cada 250 ms: una reserva o un envío de chat retiene el lote unos milisegundos.
function sampleResources(containers, db) {
  const samples = []
  const waits = []
  let busy = false
  let querying = false
  // Con la base ocupada una consulta puede tardar más de 250 ms: no se encolan en el mismo cliente.
  const locks = setInterval(() => {
    if (querying) return
    querying = true
    db.query(`SELECT count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS waiting,
        count(*) FILTER (WHERE state = 'active')::int AS active FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`).then(r => waits.push(r.rows[0]), () => {})
      .finally(() => { querying = false })
  }, 250)
  const timer = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      for (const line of (await output('docker', ['stats', '--no-stream', '--format', '{{.Name}};{{.CPUPerc}};{{.MemUsage}}'])).split('\n')) {
        const [name, cpu, memory] = line.split(';')
        const role = Object.keys(containers).find(key => containers[key] === name)
        if (role) samples.push({ role, cpu: parseFloat(cpu), memoryMb: megabytes(memory) })
      }
    } catch { /* una muestra perdida no invalida la medición */ } finally { busy = false }
  }, 2000)
  return { stop: () => {
    clearInterval(timer); clearInterval(locks)
    const usage = Object.fromEntries(Object.keys(containers).map(role => {
      const mine = samples.filter(sample => sample.role === role)
      const cpu = mine.map(sample => sample.cpu).filter(Number.isFinite)
      const memory = mine.map(sample => sample.memoryMb).filter(Number.isFinite)
      return [role, { samples: mine.length, cpuPercent: cpu.length ? { avg: Math.round(cpu.reduce((a, b) => a + b, 0) / cpu.length), max: Math.max(...cpu) } : null,
        memoryMbMax: memory.length ? Math.max(...memory) : null }]
    }))
    return { usage, lockWaits: { max: Math.max(0, ...waits.map(w => w.waiting)), samplesWithWait: waits.filter(w => w.waiting > 0).length,
      samples: waits.length, maxActive: Math.max(0, ...waits.map(w => w.active)) } }
  } }
}

const deltas = `SELECT (SELECT count(*) FROM commitments)::int reservations,
  (SELECT count(*) FROM commitments WHERE status = 'cancelled')::int cancellations, (SELECT count(*) FROM chat_messages)::int messages`

// RNF01 (anexo H p. 19): ninguna tolerancia. Cada consulta cuenta filas que violan la regla.
const INVARIANTS = [
  ['inventario', 'Q = F + O + R + E + X sin cantidades negativas en todos los lotes',
    `SELECT count(*)::int n FROM lots WHERE quantity <> free_quantity + offered_quantity + reserved_quantity + delivered_quantity
      + expired_quantity OR LEAST(free_quantity, offered_quantity, reserved_quantity, delivered_quantity, expired_quantity) < 0`],
  ['conciliación', 'R y O de cada lote coinciden con sus reservas confirmadas y ofertas vigentes',
    `SELECT count(*)::int n FROM lots l
      LEFT JOIN (SELECT lot_id, sum(quantity) r FROM commitments WHERE status = 'confirmed' GROUP BY lot_id) c ON c.lot_id = l.id
      LEFT JOIN (SELECT lot_id, sum(offered_quantity) o FROM waitlist_entries WHERE status = 'offered' GROUP BY lot_id) w ON w.lot_id = l.id
      WHERE l.reserved_quantity <> COALESCE(c.r, 0) OR l.offered_quantity <> COALESCE(w.o, 0)`],
  ['entregas', 'Como máximo una entrega por compromiso',
    'SELECT count(*)::int n FROM (SELECT commitment_id FROM deliveries GROUP BY commitment_id HAVING count(*) > 1) d'],
  ['secuencias', 'Secuencias de chat contiguas desde 1 y sin duplicados por compromiso',
    `SELECT count(*)::int n FROM (SELECT commitment_id FROM chat_messages GROUP BY commitment_id
      HAVING min(sequence) <> 1 OR max(sequence) <> count(*) OR count(DISTINCT sequence) <> count(*)) s`],
  ['outbox fallido', 'Sin eventos del outbox en error', `SELECT count(*)::int n FROM outbox_events WHERE status = 'failed'`],
  ['outbox pendiente', 'Sin eventos pendientes tras esperar al worker', `SELECT count(*)::int n FROM outbox_events WHERE status = 'pending'`],
  ['avisos', 'Cada evento procesado tiene su aviso', `SELECT count(*)::int n FROM outbox_events e WHERE e.status = 'processed'
      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.event_id = e.id AND n.user_id = e.recipient_user_id)`],
]

// Una escritura incierta para k6 (sin respuesta, 5xx o 2xx inválido) pudo confirmarse en la base:
// el delta queda entre los éxitos y los éxitos más las inciertas, que ya cuentan como errores.
async function checkInvariants(db, baseline, successes, uncertain) {
  const results = []
  for (const [name, rule, text] of INVARIANTS) {
    const value = (await db.query(text)).rows[0].n
    results.push({ name, rule, value, expected: 0, ok: value === 0 })
  }
  const after = (await db.query(deltas)).rows[0]
  for (const [name, rule, key, op] of [['reservas nuevas', 'Compromisos nuevos = reservas exitosas de k6', 'reservations', 'reserva'],
    ['cancelaciones nuevas', 'Cancelaciones nuevas = cancelaciones exitosas de k6', 'cancellations', 'cancelacion'],
    ['mensajes nuevos', 'Mensajes nuevos = envíos exitosos de k6', 'messages', 'mensaje']]) {
    const value = after[key] - baseline[key]
    const [low, high] = [successes[op] ?? 0, (successes[op] ?? 0) + (uncertain[op] ?? 0)]
    results.push({ name, rule, value, expected: low === high ? low : `${low} a ${high} (${high - low} inciertas)`, ok: value >= low && value <= high })
  }
  return results
}

// Estados por operación según la API (líneas `request` de K036), para contrastar con k6.
function statuses(lines) {
  const result = {}
  for (const line of lines) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.event !== 'request') continue
    result[event.operation] ??= {}
    result[event.operation][event.status] = (result[event.operation][event.status] ?? 0) + 1
  }
  return result
}

const values = (summary, name) => summary?.metrics?.[name]?.values ?? {}
// Sin muestras k6 informa ceros: una latencia o una tasa vacía no cumple ninguna meta.
// `con_inesperados` suma a los éxitos los errores inesperados (sin respuesta = 10 s): es el P95 de las metas.
const latency = (summary, op, phase, suffix = '') => {
  const trend = values(summary, `k032_${op}${suffix}{fase:${phase}}`)
  return trend.count ? trend : {}
}
const errorsOf = (summary, op, phase) => {
  const rate = values(summary, `k032_errores{op:${op},fase:${phase}}`)
  const total = (rate.passes ?? 0) + (rate.fails ?? 0)
  return { total, unexpected: rate.passes ?? 0, rate: total ? rate.passes / total : undefined }
}

/** Cumple / no cumple por meta del anexo H p. 19 y validez del ensayo. */
function evaluate(trial) {
  const { summary, invariants } = trial
  const p95 = op => latency(summary, op, 'medida', '_con_inesperados')['p(95)']
  const successP95 = op => latency(summary, op, 'medida')['p(95)']
  const errorRate = op => errorsOf(summary, op, 'medida').rate
  const expected = ops.reduce((total, op) => total + (values(summary, `k032_esperados{op:${op},fase:medida}`).count ?? 0), 0)
  return [
    ...Object.entries(GOALS).map(([op, limit]) => ({ goal: `${op === 'busqueda' ? 'Búsqueda' : 'Reserva'} P95 ≤ ${limit} ms`,
      measured: p95(op) === undefined ? 'sin muestras' : `${fmt(p95(op))} ms (solo éxitos ${fmt(successP95(op))} ms)`,
      ok: p95(op) !== undefined && p95(op) <= limit })),
    { goal: 'Errores inesperados < 1 % por operación', measured: ops.map(op => `${op} ${fmt((errorRate(op) ?? NaN) * 100, 2)} %`).join(', '),
      ok: ops.every(op => errorRate(op) !== undefined && errorRate(op) < 0.01) },
    { goal: 'Sin iteraciones descartadas', measured: String(values(summary, 'dropped_iterations').count ?? 'sin dato'),
      ok: Boolean(summary?.metrics?.iterations) && (values(summary, 'dropped_iterations').count ?? 0) === 0 },
    { goal: 'Consistencia tras la carga (invariantes)', measured: `${invariants.filter(item => !item.ok).length} invariantes con falla`,
      ok: invariants.length > 0 && invariants.every(item => item.ok) },
    { goal: 'Validez del ensayo: 0 rechazos esperados en la fase medida', measured: String(expected), ok: summary !== null && expected === 0 },
  ]
}

const fmt = (value, digits = 1) => value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits).replace('.', ',')

async function runTrial(n, context) {
  const { user, password, address, results, dbContainer, environment } = context
  const dir = `${results}/ensayo-${n}`
  mkdirSync(dir, { recursive: true })
  const database = `rescate_k032_test_${Date.now()}_${randomBytes(4).toString('hex')}`
  const tag = `${randomBytes(3).toString('hex')}-${n}`
  const names = { api: `rescate-k039-api-${tag}`, worker: `rescate-k039-worker-${tag}`, k6: `rescate-k039-k6-${tag}` }
  context.active = Object.values(names)
  const trial = { n, database, dir, timings: {}, failures: [], summary: null, invariants: [] }
  const timed = async (key, task) => {
    const started = Date.now()
    const value = await task()
    trial.timings[key] = Date.now() - started
    return value
  }
  let db
  let sampler
  try {
    console.log(`\nEnsayo ${n}/${trials}: base ${database}`)
    await timed('createdbMs', () => compose('exec', '-T', 'db', 'createdb', '-U', user, '--template=template0', database))
    const url = new URL(`postgresql://${address}/${database}`)
    url.username = user
    url.password = password
    await timed('migrateMs', () => execFileSync(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up'], {
      cwd: api, stdio: 'ignore', env: { ...process.env, DATABASE_URL: url.href } }))
    const pickupKey = randomBytes(32)
    const secrets = { RESCATE_ALLOWED_ORIGINS: ORIGIN, CSRF_SIGNING_KEY: randomBytes(32).toString('base64'),
      PICKUP_CODE_KEY: pickupKey.toString('base64') }
    const seed = await timed('seedMs', () => seedScale(url.href, pickupKey))
    console.log(`  Semilla en ${fmt(trial.timings.seedMs / 1000)} s:`, JSON.stringify(seed.counts))
    writeFileSync(`${dir}/seed.json`, JSON.stringify(seed))
    // Igual en cada ensayo: la sonda reserva, cancela, escribe y entra a la espera antes de k6.
    const plans = await timed('explainMs', () => explainScale(url.href, seed, secrets))
    writeFileSync(`${dir}/plans.txt`, plans.map(({ label, sql, plan }) => `## ${label}\n${sql}\n\n${plan}\n`).join('\n'))
    if (n === 1) {
      console.log('  Planes (tiempo en PostgreSQL; Seq Scan de más de 1000 filas):')
      for (const { label, sql, time, scans } of summarize(plans)) {
        if (time >= 1 || scans.length) console.log(`    ${label.padEnd(34)} ${time.toFixed(2).padStart(8)} ms  ${scans.join(', ')}  ${sql.slice(0, 60)}…`)
      }
    }
    db = new pg.Client({ connectionString: url.href })
    await db.connect()

    // API y worker de la imagen del árbol actual. Las variables se heredan del entorno del
    // proceso de Compose para que la clave de la base no quede en la línea de comandos.
    const env = { ...process.env, ...secrets,
      DATABASE_URL: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@db:5432/${database}` }
    const run = (name, service, extra) => execFileSync('docker', ['compose', 'run', '-d', '--no-deps', '--name', name,
      '--label', `${OWNER_LABEL}=${process.pid}`, ...extra,
      ...Object.keys(secrets).flatMap(key => ['-e', key]), '-e', 'DATABASE_URL', service], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const tail = name => { try { return logs(name).slice(-5).join(' | ') } catch { return 'sin registro' } }
    let apiAddress
    trial.health = { before: await timed('apiColdStartMs', async () => {
      run(names.api, 'api', ['-p', remote ? `0.0.0.0:${remote.port}:3000` : '127.0.0.1::3000'])
      apiAddress = await waitFor(async () => docker('port', names.api, '3000').trim().split('\n')[0].replace('0.0.0.0:', '127.0.0.1:'), 10000, 'Docker no publicó el puerto de la API')
      return waitFor(async () => {
        const body = await health(apiAddress)
        return body.http === 200 && body.database === 'ok' ? body : null
      }, 60000, `La API no respondió /health: ${tail(names.api)}`)
    }) }
    trial.health.worker = await timed('workerColdStartMs', async () => {
      run(names.worker, 'worker', [])
      return waitFor(async () => {
        const body = await health(apiAddress)
        return body.worker === 'ok' ? body : null
      }, 90000, `El worker no informó un ciclo exitoso: ${tail(names.worker)}`)
    })
    console.log(`  Arranque en frío: API ${trial.timings.apiColdStartMs} ms, worker ${trial.timings.workerColdStartMs} ms`)
    const network = Object.keys(JSON.parse(docker('inspect', names.api, '--format', '{{json .NetworkSettings.Networks}}')))[0]

    const baseline = (await db.query(deltas)).rows[0]
    sampler = sampleResources({ db: dbContainer, api: names.api, worker: names.worker, k6: names.k6 }, db)
    console.log(`  k6 (${K6_IMAGE}, ${mix}): ${warmup} s de preparación y ${measured} s medidos`)
    const k6 = remote ? null : spawn('docker', ['run', '--rm', '--name', names.k6, '--label', `${OWNER_LABEL}=${process.pid}`, '--network', network,
      '--user', `${process.getuid()}:${process.getgid()}`,
      '-v', `${api}load:/scripts:ro`, '-v', `${dir}:/results`, '-e', 'SEED=/results/seed.json', '-e', `API_URL=http://${names.api}:3000`,
      '-e', `ORIGIN=${ORIGIN}`, '-e', `MIX=${mix}`, '-e', `WARMUP_SECONDS=${warmup}`, '-e', `MEASURED_SECONDS=${measured}`,
      K6_IMAGE, 'run', '--quiet', '/scripts/k032.js'], { stdio: 'inherit' })
    trial.k6Code = await timed('k6Ms', () => remote ? runRemoteK6(remote, { seedFile: `${dir}/seed.json`,
      scriptFile: `${api}load/k032.js`, dir, origin: ORIGIN, mix, warmup, measured })
      : new Promise((resolve, reject) => { k6.once('exit', resolve); k6.once('error', reject) }))
    Object.assign(trial, sampler.stop())
    sampler = null
    if (existsSync(`${dir}/k6-summary.json`)) trial.summary = JSON.parse(readFileSync(`${dir}/k6-summary.json`, 'utf8'))
    if (trial.k6Code !== 0) {
      const failed = Object.entries(trial.summary?.metrics ?? {}).flatMap(([name, metric]) => Object.entries(metric.thresholds ?? {})
        .filter(([, threshold]) => !threshold.ok).map(([rule]) => `${name} ${rule}`))
      trial.failures.push(failed.length ? `k6 no cumplió umbrales: ${failed.join('; ')}` : `k6 terminó con código ${trial.k6Code}`)
    }

    // Después de la carga: worker sano, outbox vacío e invariantes contra lo que k6 vio exitoso.
    trial.health.after = await health(apiAddress).catch(() => ({ http: null }))
    if (trial.health.after.http !== 200 || trial.health.after.worker !== 'ok') trial.failures.push('/health sin worker ok después de k6')
    await timed('outboxDrainMs', () => waitFor(async () => (await db.query(`SELECT count(*)::int n FROM outbox_events
      WHERE status = 'pending'`)).rows[0].n === 0, 60000, 'pendiente').catch(() => false))
    const successes = Object.fromEntries(ops.map(op => [op, values(trial.summary, `k032_${op}`).count ?? 0]))
    const uncertain = Object.fromEntries(ops.map(op => [op, values(trial.summary, `k032_inciertas{op:${op}}`).count ?? 0]))
    trial.invariants = await checkInvariants(db, baseline, successes, uncertain)
    writeFileSync(`${dir}/invariants.json`, JSON.stringify({ baseline, successes, uncertain, invariants: trial.invariants }, null, 2))
    for (const item of trial.invariants.filter(item => !item.ok)) trial.failures.push(`invariante ${item.name}: ${item.value} (esperado ${item.expected})`)

    docker('stop', '-t', '10', names.worker, names.api)
    // Un registro incompleto no se resume: sus estados contarían menos solicitudes de las hechas.
    trial.apiStatuses = null
    for (const role of ['api', 'worker']) {
      try {
        const lines = logs(names[role])
        writeFileSync(`${dir}/${role}.log`, `${lines.join('\n')}\n`)
        if (role === 'api') trial.apiStatuses = statuses(lines)
      } catch (error) { trial.failures.push(`registro de ${role} incompleto: ${safe(error)}`) }
    }

    const limits = name => {
      const [cpus, memory] = docker('inspect', name, '--format', '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}').trim().split(' ').map(Number)
      return { cpus: cpus ? cpus / 1e9 : 'sin límite', memoryMb: memory ? Math.round(memory / 2 ** 20) : 'sin límite' }
    }
    const { rows: [versions] } = await db.query(`SELECT version() postgres, postgis_full_version() postgis,
      pg_size_pretty(pg_database_size(current_database())) size`)
    // Presupuesto del anexo H p. 18: 2 GB para datos e índices, medido después de la carga.
    const mb = bytes => Math.round(Number(bytes) / 2 ** 20 * 10) / 10
    const { rows: tables } = await db.query(`SELECT c.relname AS table, pg_table_size(c.oid) AS data, pg_indexes_size(c.oid) AS indexes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY pg_total_relation_size(c.oid) DESC`)
    trial.sizes = { dataAndIndexesMb: mb(tables.reduce((total, row) => total + Number(row.data) + Number(row.indexes), 0)),
      tables: tables.slice(0, 8).map(row => ({ table: row.table, dataMb: mb(row.data), indexesMb: mb(row.indexes) })) }
    trial.resources = { trial: n, mix, warmupSeconds: warmup, measuredSeconds: measured, database, ...environment,
      postgres: versions.postgres.split(' on ')[0], postgis: versions.postgis, databaseSize: versions.size, sizes: trial.sizes,
      containers: { db: { name: dbContainer, ...limits(dbContainer), platform: environment.dbPlatform },
        api: { image: 'Compose api (imagen del árbol actual)', ...limits(names.api) }, worker: { image: 'Compose worker', ...limits(names.worker) },
        ...(remote ? {} : { k6: { image: K6_IMAGE, cpus: 'sin límite', memoryMb: 'sin límite' } }) },
      pools: { api: 8, worker: 2 },
      network: remote ? `k6 en ${environment.generator.hostname} → ${remote.apiUrl}; /health desde el servidor` : `k6 → API por la red ${network} de Compose (http://<contenedor api>:3000), sin puertos publicados; /health se consulta desde el host por un puerto publicado en 127.0.0.1`,
      loadGenerator: remote ? `${environment.generator.hostname}, ${environment.generator.system}, ${environment.generator.k6}; equipo separado por SSH` : 'k6 en el mismo equipo y la misma VM de Docker que API, worker y PostgreSQL: interferencia declarada; no sustituye la prueba con otro equipo (anexo H p. 18)',
      timings: trial.timings, health: trial.health, usage: trial.usage, lockWaits: trial.lockWaits, apiStatuses: trial.apiStatuses }
    writeFileSync(`${dir}/resources.json`, JSON.stringify(trial.resources, null, 2))
  } catch (error) {
    trial.failures.push(`error: ${safe(error)}`)
  } finally {
    if (sampler) Object.assign(trial, sampler.stop())
    await db?.end().catch(() => {})
    for (const name of Object.values(names)) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
    context.active = []
  }
  trial.goals = evaluate(trial)
  trial.ok = trial.failures.length === 0 && trial.goals.every(goal => goal.ok)
  // Una base que falló se conserva para revisarla; las que cumplen se borran (cerca de 200 MB cada una).
  if (trial.ok) spawnSync('docker', ['compose', 'exec', '-T', 'db', 'dropdb', '-U', user, '--if-exists', database], { cwd: root, stdio: 'ignore' })
  return trial
}

const row = cells => `| ${cells.join(' | ')} |`
const table = (header, rows) => [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n')

function report(run, context, results) {
  const { environment } = context
  const first = results.find(trial => trial.resources)?.resources ?? environment
  const protocol = results.length >= 3 && warmup >= 120 && measured >= 600
  const { minimums } = environment
  const below = [!minimums.cpus && '2 núcleos', !minimums.memory && '4 GB de memoria', minimums.ssd !== true && 'SSD verificado', minimums.emulatedDb && 'PostGIS nativo'].filter(Boolean)
  const yes = ok => (ok ? 'cumple' : 'no cumple')
  const lines = [`# Informe de carga ${run}`, '',
    `Mezcla ${mix} a 20 solicitudes/s, ${results.length} de ${trials} ensayo(s) ejecutados con ${warmup} s de preparación y ${measured} s medidos. `
    + 'Cada ensayo restaura la semilla en una base nueva. Los percentiles son del ensayo, sin promediar.', '',
    `Resultado: ${results.filter(trial => trial.ok).length} de ${results.length} ensayos cumplen todas las metas medidas aquí. `
    + (below.length ? `El ambiente no cumple los mínimos del anexo (${below.join(', ')}).` : 'El ambiente cumple los mínimos del anexo.'), '',
    '## Ambiente', '',
    table(['Dato', 'Valor'], [
      ['Commit', `${environment.commit}${environment.dirty ? ` con cambios sin confirmar (${environment.changes.length} archivos)` : ', árbol limpio'}`],
      ['Equipo', `${environment.host.system}, ${environment.host.cpu} × ${environment.host.cpus}, ${environment.host.memoryGb} GiB`],
      ['VM de Docker', `${environment.dockerVm.system} ${environment.dockerVm.server}, ${environment.dockerVm.architecture}, ${environment.dockerVm.cpus} CPU, ${fmt(environment.dockerVm.memoryGb)} GiB`],
      ['Mínimos del anexo (p. 18)', `CPU de la VM ≥ 2: ${yes(minimums.cpus)}; memoria total de la VM ≥ 4 GiB: ${yes(minimums.memory)} `
        + `(${fmt(environment.dockerVm.memoryBytes / 2 ** 30, 2)} GiB${remote ? ', k6 en otro equipo' : ', compartida con k6 y los demás contenedores'}); `
        + `SSD: ${minimums.ssd === null ? 'no verificado' : minimums.ssd ? 'disco del host de estado sólido' : 'no cumple'}`],
      ['Servicios', environment.services],
      ['PostgreSQL', `${first.postgres ?? '-'}, contenedor ${environment.dbPlatform}${minimums.emulatedDb
        ? ` emulado sobre ${environment.dockerVm.architecture}: la emulación agrega latencia a PostgreSQL` : ''}`],
      ['PostGIS', first.postgis?.split(' PGSQL')[0] ?? '-'],
      ['Límites de contenedor', first.containers ? Object.entries(first.containers).map(([role, value]) => `${role}: CPU ${value.cpus}, memoria ${value.memoryMb}`).join('; ') : '-'],
      ['Node', `${environment.node} en el host (semilla y planes); API y worker en su imagen`],
      ['Pools', 'API 8 conexiones, worker 2'],
      ['k6', `${environment.generator?.k6 ?? K6_IMAGE}; ${first.network ?? '-'}`],
      ['Generador', first.loadGenerator ?? '-'],
    ]), '',
    '## Metas del anexo H (p. 19)', '',
    table(['Meta', 'Cómo se verifica aquí'], [
      ['Búsqueda P95 ≤ 1000 ms', 'k6, fase medida: éxitos y errores inesperados (una solicitud sin respuesta cuenta 10 s); se informa también el P95 solo de éxitos'],
      ['Reserva P95 ≤ 1500 ms', 'k6, fase medida, igual que la búsqueda; los rechazos esperados no entran'],
      ['Errores inesperados < 1 % por operación', 'Red, timeout de 10 s, 5xx, otros estados, 409 por otro motivo y 2xx con cuerpo inválido'],
      ['Sin iteraciones descartadas', 'dropped_iterations de k6 en ambas fases'],
      ['Consistencia sin errores de integridad', 'Aquí solo invariantes SQL tras la carga. Las pruebas críticas de la p. 23 tienen su propio script: '
        + 'último pack, misma intención, oferta y vencimiento y operador de otro establecimiento en `db:test:integrity:compose`; cancelar '
        + 'y retirar y respuesta perdida en `db:test:reservations:compose`; usuarios y operadores ajenos en `db:test:security:compose`; '
        + 'caída del worker con una tarea reclamada en `db:test:expiries:compose` y `db:test:queue-worker:compose`'],
      ['Chat visible P95 ≤ 7 s', 'No se mide aquí: `test:web:chat-latency:compose` alterna 100 mensajes en dos navegadores con Playwright'],
      ['Tareas vencidas P95 ≤ 30 s', 'No se mide aquí: `db:test:integrity:compose` vence 100 ofertas sembradas con el worker real'],
    ]), '',
    `Protocolo (tres ensayos de 120 + 600 s; mezcla e2 en E2 y e3 desde E3): ${protocol ? `cumple la forma con ${mix}` : 'no cumple la forma; esta corrida es parcial'}. `
    + (remote ? 'Generador separado: comprobar además que ambos equipos comparten la red de prueba (anexo H p. 18).' : 'Con un solo equipo el resultado no sustituye la prueba con un generador separado (anexo H p. 18).')]
  for (const trial of results) {
    const metric = name => values(trial.summary, name)
    lines.push('', `## Ensayo ${trial.n}: ${trial.ok ? 'cumple' : 'no cumple'}`, '', `Base \`${trial.database}\`${trial.ok ? ' (borrada)' : ' (conservada para revisar)'}.`)
    if (trial.failures.length) lines.push('', ...trial.failures.map(failure => `- ${failure}`))
    for (const phase of ['medida', 'preparacion']) {
      lines.push('', phase === 'medida' ? '### Fase medida' : '### Preparación (calentamiento)', '',
        ...(phase === 'medida' ? [] : ['La API y el worker arrancan en frío, pero PostgreSQL no: la semilla y los planes recorren las mismas tablas justo antes.', '']),
        table(['Operación', 'p50 ms', 'p95 ms', 'max ms', 'n éxitos', 'p95 con inesperados', 'Solicitudes', 'Inesperados', 'Esperados', 'Meta p95'], ops.map(op => {
          const trend = latency(trial.summary, op, phase)
          const { total, unexpected, rate } = errorsOf(trial.summary, op, phase)
          return [op, fmt(trend.med), fmt(trend['p(95)']), fmt(trend.max), trend.count ?? 0,
            fmt(latency(trial.summary, op, phase, '_con_inesperados')['p(95)']), total,
            `${unexpected} (${fmt(rate === undefined ? undefined : rate * 100, 2)} %)`,
            metric(`k032_esperados{op:${op},fase:${phase}}`).count ?? 0, GOALS[op] && phase === 'medida' ? `≤ ${GOALS[op]}` : '-']
        })))
    }
    const dropped = ops.flatMap(op => ['preparacion', 'medida'].map(phase => [`${op}_${phase}`, metric(`dropped_iterations{scenario:${op}_${phase}}`).count ?? 0]))
    lines.push('', '### Descartadas, conexiones y arranque', '',
      `Iteraciones descartadas: ${metric('dropped_iterations').count ?? '-'}${dropped.some(([, value]) => value) ? ` (${dropped.filter(([, value]) => value).map(([name, value]) => `${name} ${value}`).join(', ')})` : ''}.`, '',
      table(['Fase', 'Bloqueo/DNS p50', 'p95', 'max', 'Conexión p50', 'p95', 'max', 'Conexiones nuevas'], ['preparacion', 'medida'].map(phase => {
        const blocked = metric(`http_req_blocked{fase:${phase}}`).count ? metric(`http_req_blocked{fase:${phase}}`) : {}
        const connecting = metric(`http_req_connecting{fase:${phase}}`).count ? metric(`http_req_connecting{fase:${phase}}`) : {}
        return [phase, fmt(blocked.med, 3), fmt(blocked['p(95)'], 3), fmt(blocked.max, 3), fmt(connecting.med, 3), fmt(connecting['p(95)'], 3),
          fmt(connecting.max, 3), metric(`k032_conexiones_nuevas{fase:${phase}}`).count ?? 0]
      })), '',
      `Escrituras inciertas para k6 (sin respuesta, 5xx o 2xx inválido): ${['reserva', 'cancelacion', 'mensaje'].filter(op => ops.includes(op))
        .map(op => `${op} ${metric(`k032_inciertas{op:${op}}`).count ?? 0}`).join(', ')}.`, '',
      `Arranque en frío medido desde el host: API ${trial.timings.apiColdStartMs ?? '-'} ms hasta /health con base ok; worker ${trial.timings.workerColdStartMs ?? '-'} ms hasta su primer ciclo. `
      + 'Incluye crear el contenedor con `docker compose run` y publicar el puerto, no solo el arranque de Node. '
      + `Siembra ${fmt((trial.timings.seedMs ?? NaN) / 1000)} s, planes ${fmt((trial.timings.explainMs ?? NaN) / 1000)} s, vaciado del outbox ${trial.timings.outboxDrainMs ?? '-'} ms.`)
    if (trial.sizes) {
      lines.push('', `Datos e índices tras la carga: ${fmt(trial.sizes.dataAndIndexesMb)} MB de los 2048 MB presupuestados (anexo H p. 18); base completa ${trial.resources?.databaseSize ?? '-'}. `
        + `Mayores tablas (datos + índices, MB): ${trial.sizes.tables.map(t => `${t.table} ${fmt(t.dataMb)} + ${fmt(t.indexesMb)}`).join(', ')}.`)
    }
    if (trial.invariants.length) {
      lines.push('', '### Invariantes', '', table(['Regla', 'Valor', 'Esperado', 'Cumple'],
        trial.invariants.map(item => [item.rule, item.value, item.expected, item.ok ? 'sí' : 'no'])))
    }
    if (trial.apiStatuses) {
      lines.push('', '### Estados según la API', '', 'Ambas fases y el setup de k6; /health no se registra.', '', table(['Operación', 'Estados'], Object.entries(trial.apiStatuses)
        .map(([operation, counts]) => [`\`${operation}\``, Object.entries(counts).map(([status, total]) => `${status}: ${total}`).join(', ')])))
    }
    if (trial.usage) {
      lines.push('', '### Recursos durante k6', '', table(['Contenedor', 'CPU % prom.', 'CPU % máx.', 'Memoria máx. MB', 'Muestras'],
        Object.entries(trial.usage).map(([role, usage]) => [role, fmt(usage.cpuPercent?.avg, 0), fmt(usage.cpuPercent?.max, 0), usage.memoryMbMax ?? '-', usage.samples])), '',
      `Esperas por bloqueo: máximo ${trial.lockWaits.max} a la vez, en ${trial.lockWaits.samplesWithWait} de ${trial.lockWaits.samples} muestras; máximo ${trial.lockWaits.maxActive} consultas activas.`)
    }
    lines.push('', '### Cumple / no cumple', '', table(['Meta', 'Medido', 'Resultado'],
      trial.goals.map(goal => [goal.goal, goal.measured, goal.ok ? 'cumple' : 'no cumple'])))
  }
  return `${lines.join('\n')}\n`
}

const context = { active: [] }
// Ctrl+C, kill o cerrar la terminal no pasan por finally: retirar aquí los contenedores del ensayo en
// curso. API y worker corren en el daemon con -d y no mueren con este proceso.
for (const [signal, code] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    for (const name of context.active) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
    process.exit(code)
  })
}

// SIGKILL no tiene manejador: la corrida siguiente retira los contenedores de procesos que ya no
// existen, que seguirían conectados a su base. Los de una corrida viva no se tocan.
function sweep() {
  const alive = pid => { try { return process.kill(pid, 0) } catch (error) { return error.code === 'EPERM' } }
  const stale = docker('ps', '-a', '--filter', `label=${OWNER_LABEL}`, '--format', `{{.ID}} {{.Label "${OWNER_LABEL}"}}`)
    .split('\n').filter(Boolean).map(line => line.split(' ')).filter(([, pid]) => !alive(Number(pid))).map(([id]) => id)
  // k6 lleva --rm: puede desaparecer entre la lista y el retiro sin que eso sea un error.
  if (stale.length) spawnSync('docker', ['rm', '-f', ...stale], { stdio: 'ignore' })
  return stale.length
}
try {
  remote = remoteConfig()
  if (!Number.isInteger(trials) || trials < 1) throw new Error('TRIALS requiere un entero positivo')
  if (!ops) throw new Error('MIX admite e2 o e3')
  if (![warmup, measured].every(value => Number.isInteger(value) && value > 0)) throw new Error('WARMUP_SECONDS y MEASURED_SECONDS requieren enteros positivos')
  const generator = remote ? await inspectGenerator(remote) : null
  context.user = compose('exec', '-T', 'db', 'printenv', 'POSTGRES_USER').trim()
  context.password = compose('exec', '-T', 'db', 'printenv', 'POSTGRES_PASSWORD').trim()
  context.address = compose('port', 'db', '5432').trim()
  if (!/^127\.0\.0\.1:\d+$/.test(context.address)) throw new Error('Se requiere el puerto loopback de K006')
  context.dbContainer = docker('inspect', compose('ps', '-q', 'db').trim(), '--format', '{{.Name}}').trim().replace(/^\//, '')
  const swept = sweep()
  if (swept) console.log(`Retirados ${swept} contenedores de una corrida interrumpida.`)
  console.log('Construyendo las imágenes api y worker de Compose…')
  let started = Date.now()
  compose('build', '--quiet', 'api', 'worker')
  const buildMs = Date.now() - started
  const info = JSON.parse(docker('info', '--format', '{{json .}}'))
  const changes = git('status', '--porcelain').split('\n').filter(Boolean)
  const dbPlatform = compose('exec', '-T', 'db', 'uname', '-m').trim()
  const arch = name => ({ arm64: 'aarch64', amd64: 'x86_64' }[name] ?? name)
  // Mínimos del servidor de prueba (anexo H p. 18). La memoria se exige en GiB: la VM la comparte con k6.
  const minimums = { cpus: info.NCPU >= 2, memory: info.MemTotal >= 4 * 2 ** 30,
    ssd: os.platform() === 'darwin' ? /Solid State:\s+Yes/.test(spawnSync('diskutil', ['info', '/'], { encoding: 'utf8' }).stdout ?? '') : null,
    emulatedDb: arch(dbPlatform) !== arch(info.Architecture) }
  context.environment = {
    commit: git('rev-parse', '--short', 'HEAD'), dirty: changes.length > 0, changes,
    host: { system: `${os.type()} ${os.release()}`, cpu: os.cpus()[0].model, cpus: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 1024 ** 3) },
    dockerVm: { system: info.OperatingSystem, server: info.ServerVersion, architecture: info.Architecture, cpus: info.NCPU,
      memoryGb: Math.round(info.MemTotal / 1024 ** 3 * 10) / 10, memoryBytes: info.MemTotal },
    generator, dbPlatform, minimums, node: `${process.version} ${process.arch}`, k6: K6_IMAGE, buildMs,
    services: remote ? 'db, api y worker de Compose; k6 por SSH en otro equipo' : 'db, api y worker de Compose; web no se levanta: k6 llama a la API directamente y el servicio web de Compose es el servidor de desarrollo de Vite',
  }
  const run = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}_${mix}`
  context.results = `${api}.k032-results/${run}`
  mkdirSync(context.results, { recursive: true })
  const results = []
  for (let n = 1; n <= trials; n++) {
    const trial = await runTrial(n, context)
    results.push(trial)
    console.log(`  Ensayo ${n}: ${trial.ok ? 'cumple' : `no cumple (${[...trial.failures, ...trial.goals.filter(goal => !goal.ok).map(goal => goal.goal)].join('; ')})`}`)
    if (trial.failures.some(failure => failure.startsWith('error:'))) break
  }
  writeFileSync(`${context.results}/informe.md`, report(run, context, results))
  console.log(`\nInforme en api/.k032-results/${run}/informe.md (seed.json contiene sesiones locales).`)
  const failed = results.filter(trial => !trial.ok)
  if (failed.length || results.length < trials) {
    for (const trial of failed) {
      console.error(`FAIL ensayo ${trial.n}: ${[...trial.failures, ...trial.goals.filter(goal => !goal.ok).map(goal => `no cumple ${goal.goal}`)].join('; ')}`)
    }
    process.exitCode = 1
  }
} catch (error) {
  console.error(`FAIL K032 medición. ${safe(error)}`)
  process.exitCode = 1
}
