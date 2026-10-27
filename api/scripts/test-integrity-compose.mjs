// K039 · base aislada en el PostgreSQL de Compose para la integridad de E3; no migra la base de
// desarrollo. Compila, corre la suite y deja integrity.json en api/.k039-results/<base>/ con los
// recursos del motor de contenedores y los límites del servicio db (anexo H p. 18).
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const api = fileURLToPath(new URL('../', import.meta.url))
const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const compose = (...args) => docker('compose', ...args)

/** CPU y memoria del motor y límites del contenedor db; sin ellos el informe queda con null. */
function runtime() {
  try {
    const [cpus, memory, system, version] = docker('info', '--format', '{{.NCPU}}|{{.MemTotal}}|{{.OperatingSystem}}|{{.ServerVersion}}')
      .trim().split('|')
    const [image, nanoCpus, limit] = docker('inspect', '--format', '{{.Config.Image}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}',
      compose('ps', '-q', 'db').trim()).trim().split('|')
    return { engine: `${system} ${version}`, engineCpus: Number(cpus), engineMemoryGb: Math.round(Number(memory) / 1024 ** 3 * 10) / 10,
      dbImage: image, dbCpuLimit: Number(nanoCpus) ? Number(nanoCpus) / 1e9 : 'sin límite',
      dbMemoryLimitGb: Number(limit) ? Math.round(Number(limit) / 1024 ** 3 * 10) / 10 : 'sin límite' }
  } catch { return null }
}

const started = Date.now()
let database
try {
  const user = compose('exec', '-T', 'db', 'printenv', 'POSTGRES_USER').trim()
  const password = compose('exec', '-T', 'db', 'printenv', 'POSTGRES_PASSWORD').trim()
  const address = compose('port', 'db', '5432').trim()
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Se requiere el puerto loopback de K006')
  database = `rescate_k039_test_${Date.now()}_${randomBytes(4).toString('hex')}`
  compose('exec', '-T', 'db', 'createdb', '-U', user, '--template=template0', database)
  const url = new URL(`postgresql://${address}/${database}`)
  url.username = user
  url.password = password
  console.log(`Base dedicada K039 creada: ${database}`)
  const env = { ...process.env, DATABASE_URL: url.href, K039_RUNTIME: JSON.stringify(runtime()) }
  execFileSync(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up'], { cwd: api, stdio: 'ignore', env })
  execFileSync('npm', ['run', 'build'], { cwd: api, stdio: 'inherit', env })
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/test-integrity.mjs'], { cwd: api, stdio: 'inherit', env, timeout: 600_000 })
  console.log(`Duración total: ${Math.round((Date.now() - started) / 1000)} s (migración, compilación y suite)`)
  console.log(`Base de prueba conservada: ${database}. No se alteró la base de desarrollo.`)
} catch {
  // Evitar errores de subprocesos que puedan contener URL/credenciales.
  console.error(`FAIL K039 integridad. Revisar salida de pruebas.${database ? ` Base prevista: ${database}.` : ''}`)
  process.exitCode = 1
}
