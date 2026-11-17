import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const api = fileURLToPath(new URL('../', import.meta.url))
const docker = (...args) => execFileSync('docker', ['compose', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let database, user
try {
  user = docker('exec', '-T', 'db', 'printenv', 'POSTGRES_USER').trim()
  const password = docker('exec', '-T', 'db', 'printenv', 'POSTGRES_PASSWORD').trim()
  const address = docker('port', 'db', '5432').trim()
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('La base de prueba requiere loopback')
  database = `rescate_triage_test_${Date.now()}_${randomBytes(4).toString('hex')}`
  docker('exec', '-T', 'db', 'createdb', '-U', user, '--template=template0', database)
  const url = new URL(`postgresql://${address}/${database}`); url.username = user; url.password = password
  const env = { ...process.env, DATABASE_URL: url.href }
  console.log(`Base dedicada de triage: ${database}`)
  execFileSync(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up'], { cwd: api, env, stdio: 'ignore' })
  execFileSync('npm', ['run', 'build'], { cwd: api, env, stdio: 'inherit' })
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/test-triage.mjs'], { cwd: api, env, stdio: 'inherit' })
} catch { console.error('FAIL triage: revisar la salida de pruebas.'); process.exitCode = 1 }
finally { if (database) docker('exec', '-T', 'db', 'dropdb', '--force', '-U', user, database) }
