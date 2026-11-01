// Generador local → API Railway por HTTPS. Bases nuevas y claves propias por ensayo.
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { promisify } from 'node:util'
import pg from 'pg'
import { createTestDatabase } from './create-test-database.mjs'
import { seedScale } from './seed-scale.mjs'
import { explainScale } from './explain-scale.mjs'
import { waitForDeployment } from './deploy-railway.mjs'
import { OPS, deltas, checkInvariants, values, latency, errorsOf, evaluate, fmt } from './support/scale-results.mjs'
import { railway, environmentQuery, variablesQuery, upsertVariables, assertLoadEnvironment, assertDatabaseProxy,
  assertLoadUrl, trialDatabaseUrls } from './support/railway-load.mjs'

const api = fileURLToPath(new URL('../', import.meta.url))
const root = fileURLToPath(new URL('../../', import.meta.url))
const execute = promisify(execFile)
const image = 'grafana/k6:1.3.0'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
const domains = instance => [...instance.domains.serviceDomains, ...instance.domains.customDomains].map(d => d.domain)
const instances = environment => environment.serviceInstances.edges.map(({ node }) => node)

async function healthy(url) {
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10000) })
  const body = await response.json()
  assert.ok(response.status === 200 && body.database === 'ok' && body.worker === 'ok', 'API o worker sin salud')
  return body
}

async function ready(url) {
  for (const deadline = Date.now() + 90000; ; await pause(2000)) {
    try { return await healthy(url) } catch { if (Date.now() > deadline) throw new Error('El despliegue no llegó a estar sano') }
  }
}

async function deploy(config, role, commit) {
  const target = ['--project', config.projectId, '--environment', config.environmentId, '--service', config.ids[role]]
  let upload
  try {
    const result = await execute('railway', ['up', 'api', '--path-as-root', '--detach', '--json', '--message', `Carga E3 ${commit}`, ...target],
      { cwd: root, timeout: 180000, maxBuffer: 4 * 2 ** 20 })
    upload = JSON.parse(result.stdout)
  } catch { throw new Error(`No se pudo subir ${role} al entorno de carga`) }
  assert.match(upload.deploymentId ?? '', /^[a-f0-9-]{36}$/i, 'Railway no devolvió deploymentId')
  console.log(`  ${role}: esperando deploy ${upload.deploymentId}`)
  await waitForDeployment(upload.deploymentId, async () => {
    const { stdout } = await execute('railway', ['deployment', 'list', '--json', '--limit', '100', ...target], { timeout: 30000 })
    return JSON.parse(stdout)
  })
  return upload.deploymentId
}

async function resourceMetrics(config, start, end) {
  const result = {}
  for (const [role, serviceId] of Object.entries(config.ids)) {
    result[role] = (await railway(`query($environmentId:String!,$serviceId:String!,$start:DateTime!,$end:DateTime!) {
      metrics(environmentId:$environmentId,serviceId:$serviceId,startDate:$start,endDate:$end,sampleRateSeconds:60,
        measurements:[CPU_USAGE,CPU_LIMIT,MEMORY_USAGE_GB,MEMORY_LIMIT_GB]) { measurement values { ts value } }
      serviceInstanceLimits(environmentId:$environmentId,serviceId:$serviceId)
    }`, { environmentId: config.environmentId, serviceId, start, end }))
    assert.ok(result[role].metrics.some(m => m.measurement === 'MEMORY_USAGE_GB' && m.values.length), `Sin muestras de memoria para ${role}`)
  }
  return result
}

function report(context, trials) {
  const lines = ['# Carga E3 por Internet hacia Railway', '',
    `Commit del generador y del código subido: ${context.commit}; árbol ${context.dirty ? 'con cambios' : 'limpio'}.`,
    `Generador: ${context.generator.hostname}, ${context.generator.system}, ${context.generator.cpus} CPU, ${context.generator.memoryGiB} GiB; ${image}.`,
    `Servidor: entorno ${context.environment.name}; API ${context.apiUrl}; PostgreSQL, API y worker en Railway.`,
    'Escenario: generador y servidor separados, conectados por Internet y HTTPS. Los mínimos físicos y la misma LAN del anexo H requieren evidencia adicional; este ensayo mide el escenario cloud del ADR 0018.',
    `Protocolo temporal: ${trials.length === 3 && context.warmup === 120 && context.measured === 600 ? 'completo' : 'parcial'}; ${trials.length} ensayos de ${context.warmup} + ${context.measured} s, mezcla e3 a 20 solicitudes/s.`,
    'Cada ensayo usa una base nueva. Los percentiles se informan individualmente, sin promediar.', '']
  for (const trial of trials) {
    lines.push(`## Ensayo ${trial.n}: ${trial.ok ? 'cumple las metas' : 'no cumple'}`, '',
      `Base ${trial.database}. Deploys: ${JSON.stringify(trial.deployments ?? {})}.`, '',
      '| Operación | P95 éxitos (ms) | P95 con inesperados (ms) | Solicitudes medidas | Inesperados | Esperados |',
      '| --- | --- | --- | --- | --- | --- |')
    for (const op of OPS.e3) {
      const errors = errorsOf(trial.summary, op, 'medida')
      lines.push(`| ${op} | ${fmt(latency(trial.summary, op, 'medida')['p(95)'])} | ${fmt(latency(trial.summary, op, 'medida', '_con_inesperados')['p(95)'])} | ${errors.total} | ${errors.unexpected} | ${values(trial.summary, `k032_esperados{op:${op},fase:medida}`).count ?? 0} |`)
    }
    lines.push('', '| Meta | Medido | Resultado |', '| --- | --- | --- |',
      ...trial.goals.map(g => `| ${g.goal} | ${g.measured} | ${g.ok ? 'cumple' : 'no cumple'} |`), '',
      ...trial.failures.map(f => `- ${f}`), '',
      `Invariantes: ${trial.invariants.filter(i => i.ok).length}/${trial.invariants.length}. Tamaño: ${trial.databaseSize ?? '-'}.`,
      'Muestras de CPU, RAM y límites por servicio en resources.json; conteos y escrituras inciertas en invariants.json.', '')
  }
  return `${lines.join('\n')}\n`
}

async function main() {
  process.umask(0o077)
  const configPath = process.env.RAILWAY_LOAD_CONFIG
  assert.ok(configPath, 'Falta RAILWAY_LOAD_CONFIG (archivo privado con IDs y URL pública de PostgreSQL de carga)')
  assert.equal(statSync(configPath).mode & 0o077, 0, 'La configuración privada requiere permisos 600')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const count = Number(process.env.TRIALS ?? 3)
  const warmup = Number(process.env.WARMUP_SECONDS ?? 120), measured = Number(process.env.MEASURED_SECONDS ?? 600)
  assert.ok([count, warmup, measured].every(n => Number.isInteger(n) && n > 0), 'Duraciones y ensayos deben ser enteros positivos')
  const environment = (await railway(environmentQuery, { id: config.environmentId })).environment
  const production = (await railway(environmentQuery, { id: config.productionEnvironmentId })).environment
  assert.equal(config.projectId, environment.projectId)
  assertLoadEnvironment(environment, production, config.ids)
  const stageApi = instances(environment).find(i => i.serviceId === config.ids.api)
  const prodDomains = instances(production).flatMap(domains)
  const apiUrl = assertLoadUrl(config.apiUrl ?? `https://${domains(stageApi)[0]}`, prodDomains, domains(stageApi))
  const variables = (await railway(variablesQuery, { projectId: config.projectId, environmentId: config.environmentId, serviceId: config.ids.db })).variables
  // El destino público debe autenticar contra el PostgreSQL aislado, nunca un servidor arbitrario.
  const publicUrl = new URL(config.publicDatabaseUrl), privateUrl = new URL(variables.DATABASE_URL)
  const { tcpProxies } = await railway(`query($environmentId:String!,$serviceId:String!) {
    tcpProxies(environmentId:$environmentId,serviceId:$serviceId) { domain proxyPort }
  }`, { environmentId: config.environmentId, serviceId: config.ids.db })
  assertDatabaseProxy(publicUrl.href, tcpProxies)
  assert.equal(publicUrl.username, privateUrl.username, 'Usuario PostgreSQL de carga incorrecto')
  assert.equal(publicUrl.password, privateUrl.password, 'Credenciales PostgreSQL de carga incorrectas')
  const git = (...args) => execFileSync('git', ['-c', `safe.directory=${root.replace(/\/$/, '')}`, ...args], { cwd: root, encoding: 'utf8' }).trim()
  const context = { commit: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain')), environment, apiUrl, warmup, measured,
    generator: { hostname: os.hostname(), system: `${os.type()} ${os.release()}`, cpus: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30) } }
  const run = `railway_${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`
  const resultDir = `${api}.k032-results/${run}`
  mkdirSync(resultDir, { recursive: true, mode: 0o700 })
  save(`${resultDir}/environment.json`, context)
  const trials = []
  let activeK6
  let activeContainer
  let interrupted = false
  const stop = () => { interrupted = true; activeK6?.kill('SIGTERM') }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    for (let n = 1; n <= count; n++) {
      const dir = `${resultDir}/ensayo-${n}`
      mkdirSync(dir, { mode: 0o700 })
      const trial = { n, database: `rescate_k032_railway_${Date.now()}_${randomBytes(3).toString('hex')}`, summary: null, invariants: [], failures: [], timings: {} }
      trials.push(trial)
      let db
      let step = 'crear base'
      const timed = async (name, task) => {
        assert.ok(!interrupted, 'Carga interrumpida')
        step = name
        console.log(`  ${name}…`)
        const start = Date.now(), value = await task()
        trial.timings[name] = Date.now() - start
        assert.ok(!interrupted, 'Carga interrumpida')
        return value
      }
      try {
        console.log(`Ensayo ${n}/${count}: creando ${trial.database}`)
        const [connectionString, serverConnectionString] = trialDatabaseUrls(publicUrl.href, privateUrl.href, trial.database)
        await createTestDatabase(publicUrl.href, trial.database)
        await timed('migrateMs', () => execute(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up'],
          { cwd: api, env: { ...process.env, DATABASE_URL: connectionString }, timeout: 180000, maxBuffer: 4 * 2 ** 20 }))
        const pickupKey = randomBytes(32)
        const secrets = { PICKUP_CODE_KEY: pickupKey.toString('base64'), CSRF_SIGNING_KEY: randomBytes(32).toString('base64'), RESCATE_ALLOWED_ORIGINS: apiUrl }
        const seed = await timed('seedMs', () => seedScale(connectionString, pickupKey, message => console.log(`  ${message}`)))
        save(`${dir}/seed.json`, seed)
        console.log(`  Semilla lista en ${fmt(trial.timings.seedMs / 1000)} s: ${JSON.stringify(seed.counts)}`)
        const plans = await timed('plansMs', () => explainScale(connectionString, seed, secrets))
        writeFileSync(`${dir}/plans.txt`, plans.map(p => `## ${p.label}\n${p.sql}\n${p.plan}`).join('\n\n'))
        // Reemplazo completo: las credenciales de fotos o de producción no se heredan al servicio de carga.
        for (const role of ['api', 'worker']) await railway(upsertVariables, { input: {
          projectId: config.projectId, environmentId: config.environmentId, serviceId: config.ids[role], replace: true, skipDeploys: true,
          variables: { ...secrets, DATABASE_URL: serverConnectionString, NODE_ENV: 'production', PORT: '3000' },
        } })
        trial.deployments = {}
        for (const role of ['api', 'worker']) trial.deployments[role] = await timed(`${role}DeployMs`, () => deploy(config, role, context.commit))
        trial.healthBefore = await timed('healthBeforeMs', () => ready(apiUrl))
        db = new pg.Client({ connectionString, statement_timeout: 10000, connectionTimeoutMillis: 15000 })
        await db.connect()
        const baseline = (await db.query(deltas)).rows[0]
        trial.loadStart = new Date().toISOString()
        console.log(`  k6 HTTPS: ${warmup} s preparación + ${measured} s medidos`)
        const name = `rescate-railway-k6-${process.pid}-${n}`
        activeContainer = name
        activeK6 = spawn('docker', ['run', '--rm', '--name', name, '--user', `${process.getuid()}:${process.getgid()}`,
          '-v', `${api}load:/scripts:ro`, '-v', `${dir}:/results`, '-e', 'SEED=/results/seed.json',
          '-e', `API_URL=${apiUrl}`, '-e', `ORIGIN=${apiUrl}`, '-e', 'MIX=e3', '-e', `WARMUP_SECONDS=${warmup}`,
          '-e', `MEASURED_SECONDS=${measured}`, image, 'run', '--quiet', '/scripts/k032.js'], { stdio: 'inherit' })
        trial.k6Code = await timed('loadMs', () => new Promise((resolve, reject) => { activeK6.once('exit', resolve); activeK6.once('error', reject) }))
        activeK6 = null
        trial.loadEnd = new Date().toISOString()
        trial.summary = JSON.parse(readFileSync(`${dir}/k6-summary.json`, 'utf8'))
        if (trial.k6Code !== 0) trial.failures.push(`k6 terminó con código ${trial.k6Code}`)
        trial.healthAfter = await timed('healthAfterMs', () => healthy(apiUrl))
        step = 'outbox e invariantes'
        for (const deadline = Date.now() + 60000; ; await pause(1000)) {
          if ((await db.query("SELECT count(*)::int n FROM outbox_events WHERE status='pending'")).rows[0].n === 0) break
          if (Date.now() > deadline) { trial.failures.push('Outbox sin vaciar tras 60 s'); break }
        }
        const successes = Object.fromEntries(OPS.e3.map(op => [op, values(trial.summary, `k032_${op}`).count ?? 0]))
        const uncertain = Object.fromEntries(OPS.e3.map(op => [op, values(trial.summary, `k032_inciertas{op:${op}}`).count ?? 0]))
        trial.invariants = await checkInvariants(db, baseline, successes, uncertain)
        save(`${dir}/invariants.json`, { baseline, successes, uncertain, invariants: trial.invariants })
        const versions = (await db.query('SELECT version() postgres, postgis_full_version() postgis, pg_size_pretty(pg_database_size(current_database())) size')).rows[0]
        trial.databaseSize = versions.size
        // Las métricas del proveedor llegan con demora; conservar muestras crudas y límites por servicio.
        step = 'recursos Railway'
        await pause(15000)
        const resources = await resourceMetrics(config, trial.loadStart, trial.loadEnd)
        save(`${dir}/resources.json`, { ...versions, resources, deployments: trial.deployments, timings: trial.timings,
          network: 'Generador local → Internet → HTTPS Railway; PostgreSQL por red privada desde API/worker',
          physicalMinimums: 'CPU/RAM son límites por servicio; SSD, memoria disponible del host y ausencia de emulación requieren evidencia adicional' })
      } catch (error) {
        // PostgreSQL y CLI pueden incluir URLs con contraseña en el error: no imprimirlo ni persistirlo.
        trial.failures.push(`Ejecución incompleta en ${step}; revisar logs privados del entorno de carga`)
        writeFileSync(`${dir}/error-private.txt`, String(error?.message ?? 'error'), { mode: 0o600 })
      } finally {
        if (activeContainer) await execute('docker', ['rm', '-f', activeContainer], { timeout: 30000 }).catch(() => {})
        activeContainer = null
        await db?.end().catch(() => {})
      }
      trial.goals = evaluate(trial)
      trial.ok = trial.k6Code === 0 && trial.failures.length === 0 && trial.goals.every(g => g.ok)
      save(`${dir}/trial.json`, trial)
      writeFileSync(`${resultDir}/informe.md`, report(context, trials))
      console.log(`  Ensayo ${n}: ${trial.ok ? 'cumple' : 'no cumple'}. Informe: ${resultDir}/informe.md`)
      if (trial.failures.length) break
    }
  } finally {
    stop()
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
  }
  console.log('Las bases y servicios de carga se conservan para inspección. Retirar el entorno de prueba al terminar.')
  if (trials.length !== count || trials.some(t => !t.ok)) process.exitCode = 1
}

main().catch(error => {
  mkdirSync(`${api}.k032-results`, { recursive: true, mode: 0o700 })
  writeFileSync(`${api}.k032-results/preflight-error-private.txt`, String(error?.message ?? 'error'), { mode: 0o600 })
  console.error('FAIL carga Railway: revisa acceso, configuración privada y entorno carga-e3; detalle privado en .k032-results/preflight-error-private.txt.')
  process.exitCode = 1
})
