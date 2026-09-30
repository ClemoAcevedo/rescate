// K009/K011: recorridos de navegador (logout usa respuestas controladas) contra Vite HTTPS → proxy → API → PostgreSQL de Compose.
// Usa una base dedicada nueva; no migra ni altera la base de desarrollo.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const api = fileURLToPath(new URL('../', import.meta.url))
const web = fileURLToPath(new URL('../../web/', import.meta.url))
const apiPort = 3100
const webUrl = 'https://localhost:5174'
const docker = (...args) => execFileSync('docker', ['compose', ...args], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
})

// Vite usa un certificado efímero; solo se confía en él para esta comprobación.
function ready(ca) {
  return new Promise((resolve) => {
    const req = request(`${webUrl}/api/health`, { ca, timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200) })
    req.on('error', () => resolve(false)).on('timeout', () => { req.destroy(); resolve(false) }).end()
  })
}

const children = []
let database
let dir
try {
  const user = docker('exec', '-T', 'db', 'printenv', 'POSTGRES_USER').trim()
  const password = docker('exec', '-T', 'db', 'printenv', 'POSTGRES_PASSWORD').trim()
  const address = docker('port', 'db', '5432').trim()
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Se requiere el puerto loopback de K006')
  database = `rescate_web_test_${Date.now()}_${randomBytes(4).toString('hex')}`
  docker('exec', '-T', 'db', 'createdb', '-U', user, '--template=template0', database)
  const url = new URL(`postgresql://${address}/${database}`)
  url.username = user
  url.password = password
  const env = { ...process.env, DATABASE_URL: url.href }
  console.log(`Base dedicada web creada: ${database}`)
  execFileSync(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up'], { cwd: api, env, stdio: 'ignore' })

  dir = await mkdtemp(join(tmpdir(), 'rescate-web-'))
  const cert = join(dir, 'cert.pem')
  const key = join(dir, 'key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })

  children.push(spawn(process.execPath, ['dist/index.js'], { cwd: api, stdio: ['ignore', 'ignore', 'inherit'], env: {
    ...env, PORT: String(apiPort), RESCATE_ALLOWED_ORIGINS: webUrl, CSRF_SIGNING_KEY: randomBytes(32).toString('base64'),
  } }))
  children.push(spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5174', '--strictPort'], {
    cwd: web, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, DEV_TLS_CERT_FILE: cert, DEV_TLS_KEY_FILE: key, API_PROXY_TARGET: `http://localhost:${apiPort}` },
  }))
  const ca = await readFile(cert)
  let up = false
  for (let attempt = 0; attempt < 60 && !up; attempt++) {
    up = await ready(ca)
    if (!up) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!up) throw new Error('API o Vite no respondieron')

  for (const script of ['test:web:auth', 'test:web:logout', 'test:web:lots', 'db:test:discovery', 'test:web:discovery']) {
    execFileSync('npm', ['run', script], { cwd: api, stdio: 'inherit', env: { ...env, WEB_URL: webUrl } })
  }
  console.log(`Base de prueba conservada: ${database}. No se alteró la base de desarrollo.`)
} catch {
  // Evitar errores de subprocesos que puedan contener URL/credenciales.
  console.error(`FAIL recorridos web. Revisar salida de pruebas.${database ? ` Base prevista: ${database}.` : ''}`)
  process.exitCode = 1
} finally {
  await Promise.all(children.filter((child) => child.exitCode === null).map((child) => {
    const stopped = once(child, 'exit'); child.kill('SIGTERM'); return stopped
  }))
  if (dir) await rm(dir, { recursive: true, force: true })
}
