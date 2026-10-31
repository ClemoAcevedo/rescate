// K040: instancia local para los cinco recorridos moderados (docs/accesibilidad.md).
// Levanta una base dedicada, API, worker y Vite HTTPS, y deja un intérprete para que
// el moderador prepare a cada participante con datos propios por la API real.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createTestDatabase } from './create-test-database.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const api = fileURLToPath(new URL('../', import.meta.url))
const web = fileURLToPath(new URL('../../web/', import.meta.url))
const apiPort = 3100
const webUrl = 'https://localhost:5174'
// Contraseña pública y solo local, como la semilla K012: las cuentas son ficticias.
const PASSWORD = 'Recorridos-solo-local-2026'
const OPERATOR = 'operador.recorridos@example.test'
// Una cuenta tiene una reserva por lote: dos de apoyo ocupan los 10 packs (4 + 6).
const SUPPORT_OFFER = 'apoyo.oferta@example.test'
const SUPPORT_REST = 'apoyo.resto@example.test'
const ESTABLISHMENT = { name: 'Panadería de prueba', address: 'Dirección ficticia de prueba 123, Santiago', latitude: -33.45, longitude: -70.66 }
const docker = (...args) => execFileSync('docker', ['compose', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const minutes = n => n * 60_000
let ca

/** HTTPS contra Vite con su certificado efímero; cookies, Origin y CSRF como el navegador. */
function call(jar, method, path, json) {
  const body = json === undefined ? undefined : JSON.stringify(json)
  const headers = { Origin: webUrl, Cookie: [...jar.cookies].filter(([, value]) => value).map(([name, value]) => `${name}=${value}`).join('; '),
    ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method === 'GET' ? {} : { 'X-CSRF-Token': jar.csrf }) }
  return new Promise((resolve, reject) => {
    const req = request(`${webUrl}/api${path}`, { method, headers, ca, timeout: 10_000 }, res => {
      for (const line of res.headers['set-cookie'] ?? []) {
        const [pair] = line.split(';')
        jar.cookies.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1))
      }
      let text = ''
      res.setEncoding('utf8').on('data', chunk => { text += chunk }).on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject).on('timeout', () => req.destroy(new Error(`${method} ${path} sin respuesta`))).end(body)
  })
}

async function expect(jar, status, method, path, json) {
  const response = await call(jar, method, path, json)
  if (response.status !== status) throw new Error(`${method} ${path} respondió ${response.status} ${response.body?.error?.code ?? ''}`)
  return response.body
}

async function signIn(email) {
  const jar = { cookies: new Map(), csrf: undefined }
  jar.csrf = (await expect(jar, 200, 'GET', '/auth/session')).csrfToken
  await expect(jar, 200, 'POST', '/auth/login', { email, password: PASSWORD })
  jar.csrf = (await expect(jar, 200, 'GET', '/auth/session')).csrfToken
  return jar
}

async function register(email) {
  const jar = { cookies: new Map(), csrf: undefined }
  jar.csrf = (await expect(jar, 200, 'GET', '/auth/session')).csrfToken
  const { status } = await call(jar, 'POST', '/auth/register', { email, password: PASSWORD, privacyConsent: true })
  if (status !== 201 && status !== 409) throw new Error(`Registro de ${email}: ${status}`)
}

const participantEmail = id => `participante.${id.toLowerCase()}@example.test`
const participants = new Map()

async function establishmentOf(operator) {
  const { session } = await expect(operator, 200, 'GET', '/auth/session')
  return session.operableEstablishments[0].id
}

async function publish(operator, establishmentId, input) {
  const now = Date.now()
  const lot = await expect(operator, 201, 'POST', `/establishments/${establishmentId}/lots`, { ...input, address: ESTABLISHMENT.address,
    latitude: ESTABLISHMENT.latitude, longitude: ESTABLISHMENT.longitude, timeZone: 'America/Santiago',
    pickupStartsAt: new Date(now - minutes(10)).toISOString(), pickupEndsAt: new Date(now + minutes(180)).toISOString() })
  return expect(operator, 200, 'POST', `/lots/${lot.id}/publish`, { version: lot.version })
}

/** Retira los lotes abiertos del participante anterior y crea los de este. */
async function prepare(id) {
  await register(participantEmail(id))
  const operator = await signIn(OPERATOR)
  const establishmentId = await establishmentOf(operator)
  const { items } = await expect(operator, 200, 'GET', `/establishments/${establishmentId}/lots?status=published`)
  for (const lot of items.filter(item => Date.parse(item.pickupEndsAt) > Date.now())) {
    const { version } = await expect(operator, 200, 'GET', `/lots/${lot.id}/management`)
    await expect(operator, 200, 'POST', `/lots/${lot.id}/management`, { action: 'withdraw', version,
      reason: 'Cierre de los datos del recorrido anterior', idempotencyKey: randomUUID() })
  }
  const available = await publish(operator, establishmentId, { description: 'Pack de verduras de temporada: zanahorias, zapallo y acelga.',
    category: 'Verduras', quantity: 6, conditions: 'Trae tu bolsa reutilizable.' })
  const soldOut = await publish(operator, establishmentId, { description: 'Pack de pan del día: marraquetas y hallullas horneadas esta mañana.',
    category: 'Panadería', quantity: 10, conditions: null })
  const reservation = await expect(await signIn(SUPPORT_OFFER), 201, 'POST', `/public/lots/${soldOut.id}/reservations`, { quantity: 4, idempotencyKey: randomUUID() })
  await expect(await signIn(SUPPORT_REST), 201, 'POST', `/public/lots/${soldOut.id}/reservations`, { quantity: 6, idempotencyKey: randomUUID() })
  participants.set(id, { soldOutId: soldOut.id, supportReservationId: reservation.id })
  console.log(`${id} listo: ${participantEmail(id)} (contraseña ${PASSWORD}).`)
  console.log(`  Disponible: «${available.description}», 6 packs. Sin packs libres: «${soldOut.description}», 10 reservados por las cuentas de apoyo.`)
  console.log('  Inicia la sesión del participante antes de empezar; la contraseña no va en la ficha.')
}

/** Recorrido 5: la reserva de 4 se cancela y la cola ofrece esos 4 de los 10 pedidos. */
async function offer(id) {
  const data = participants.get(id)
  if (!data) throw new Error(`Primero: preparar ${id}`)
  const participant = await signIn(participantEmail(id))
  const { items } = await expect(participant, 200, 'GET', '/waitlist')
  const entry = items.find(item => item.lot.id === data.soldOutId && item.status === 'waiting')
  if (!entry) throw new Error(`${id} no está esperando en el lote sin packs libres: falta el recorrido 4`)
  await expect(await signIn(SUPPORT_OFFER), 200, 'POST', `/reservations/${data.supportReservationId}/cancel`, {})
  const offered = await expect(participant, 200, 'GET', `/waitlist/${entry.id}`)
  console.log(`${id}: oferta por ${offered.offeredQuantity} de ${offered.requestedQuantity} packs, vence ${new Date(offered.offerExpiresAt).toLocaleTimeString('es-CL', { timeZone: 'America/Santiago' })}.`)
}

const children = []
let dir
let database
try {
  database = `rescate_recorridos_${Date.now()}_${randomBytes(4).toString('hex')}`
  let databaseUrl
  if (process.env.DATABASE_URL) {
    databaseUrl = await createTestDatabase(process.env.DATABASE_URL, database)
  } else {
    const user = docker('exec', '-T', 'db', 'printenv', 'POSTGRES_USER').trim()
    const password = docker('exec', '-T', 'db', 'printenv', 'POSTGRES_PASSWORD').trim()
    const address = docker('port', 'db', '5432').trim()
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Se requiere el puerto loopback de Compose')
    docker('exec', '-T', 'db', 'createdb', '-U', user, '--template=template0', database)
    const url = new URL(`postgresql://${address}/${database}`)
    url.username = user
    url.password = password
    databaseUrl = url.href
  }
  const env = { ...process.env, DATABASE_URL: databaseUrl }
  execFileSync(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up'], { cwd: api, env, stdio: 'ignore' })

  dir = await mkdtemp(join(tmpdir(), 'rescate-recorridos-'))
  const cert = join(dir, 'cert.pem')
  const key = join(dir, 'key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
  ca = await readFile(cert)
  const photoEnv = { PHOTO_STORAGE: 'local', PHOTO_LOCAL_DIR: join(dir, 'photos') }
  children.push(spawn(process.execPath, ['dist/index.js'], { cwd: api, stdio: ['ignore', 'ignore', 'inherit'], env: {
    ...env, ...photoEnv, PORT: String(apiPort), RESCATE_ALLOWED_ORIGINS: webUrl, CSRF_SIGNING_KEY: randomBytes(32).toString('base64'),
    PICKUP_CODE_KEY: randomBytes(32).toString('base64'),
  } }))
  // Worker completo: las ofertas y los lotes vencen a su hora durante la sesión.
  children.push(spawn(process.execPath, ['dist/worker.js'], { cwd: api, stdio: ['ignore', 'ignore', 'inherit'], env: { ...env, ...photoEnv } }))
  children.push(spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5174', '--strictPort'], {
    cwd: web, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, DEV_TLS_CERT_FILE: cert, DEV_TLS_KEY_FILE: key, API_PROXY_TARGET: `http://localhost:${apiPort}` },
  }))
  let up = false
  for (let attempt = 0; attempt < 60 && !up; attempt++) {
    up = await call({ cookies: new Map() }, 'GET', '/health').then(response => response.status === 200, () => false)
    if (!up) await sleep(500)
  }
  if (!up) throw new Error('API o Vite no respondieron')

  await register(OPERATOR)
  await register(SUPPORT_OFFER)
  await register(SUPPORT_REST)
  const db = new pg.Client({ connectionString: databaseUrl })
  await db.connect()
  try {
    await db.query(`WITH e AS (INSERT INTO establishments (name, address, latitude, longitude, time_zone)
      VALUES ($1, $2, $3, $4, 'America/Santiago') RETURNING id)
      INSERT INTO memberships (user_id, establishment_id) SELECT u.id, e.id FROM users u, e WHERE u.email = $5`,
    [ESTABLISHMENT.name, ESTABLISHMENT.address, ESTABLISHMENT.latitude, ESTABLISHMENT.longitude, OPERATOR])
  } finally {
    await db.end()
  }

  console.log(`Instancia de recorridos en ${webUrl} (base ${database}). El navegador pedirá aceptar el certificado local.`)
  console.log(`Operador: ${OPERATOR}. Contraseña de todas las cuentas: ${PASSWORD}.`)
  console.log('Comandos: «preparar P01» antes de cada sesión, «ofrecer P01» justo antes del recorrido 5, «salir».')
  const input = createInterface({ input: process.stdin, output: process.stdout })
  // Ctrl+C en la terminal o una señal del proceso cierran igual: se detienen los servicios.
  input.on('SIGINT', () => input.close())
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => input.close())
  for await (const line of input) {
    const [command, id] = line.trim().split(/\s+/)
    try {
      if (command === 'salir') break
      if (!['preparar', 'ofrecer'].includes(command) || !/^P\d{2}$/.test(id ?? '')) console.log('Uso: preparar P01 | ofrecer P01 | salir')
      else if (command === 'preparar') await prepare(id)
      else await offer(id)
    } catch (error) {
      console.error(`FAIL: ${error.message}`)
    }
  }
  input.close()
  console.log(`Base conservada: ${database}. No se alteró la base de desarrollo.`)
} catch (error) {
  // Sin detalles de subprocesos: pueden contener la URL de la base.
  console.error(`FAIL instancia de recorridos: ${error.message.split('\n')[0]}`)
  process.exitCode = 1
} finally {
  await Promise.all(children.filter(child => child.exitCode === null).map(child => {
    const stopped = once(child, 'exit'); child.kill('SIGTERM'); return stopped
  }))
  if (dir) await rm(dir, { recursive: true, force: true })
  process.stdin.destroy()
}
