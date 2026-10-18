import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import pg from 'pg'
import { chromium } from 'playwright'

// K031: cola, vencimiento y avisos en tres navegadores contra Vite HTTPS → proxy → API →
// PostgreSQL. Lanza su propio worker con vencimientos, lo mata con kill -9 tras reclamar
// el vencimiento de una oferta y lo reinicia. Va al final de test:web:compose, porque
// los recorridos anteriores esperan vencimientos sin registrar.
const baseUrl = (process.env.WEB_URL ?? 'https://localhost:5174').replace(/\/$/, '')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL debe apuntar a la base de prueba usada por la API')
const password = 'K031-queue-worker-password'
const run = Date.now()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
// Fuera de la transacción que retiene el bloqueo: pg_stat_activity se congela dentro de ella.
const observer = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
await observer.connect()
const browser = await chromium.launch({ headless: true })
const contexts = []
const ok = (message) => console.log(`✓ ${message}`)

/** Navegador propio: cookies y sesión separadas. */
async function browserFor(label) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: 'America/Santiago', viewport: { width: 1280, height: 720 } })
  contexts.push(context)
  const call = async (method, path, data) => {
    const session = await (await context.request.get(`${baseUrl}/api/auth/session`)).json()
    const response = await context.request.fetch(`${baseUrl}/api${path}`, { method, data, headers: { Origin: baseUrl, 'X-CSRF-Token': session.csrfToken } })
    return { status: response.status(), body: response.status() === 204 ? null : await response.json() }
  }
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => { if (response.status() >= 429) errors.push(`${response.status()} ${new URL(response.url()).pathname}`) })
  return { label, context, call, page, errors }
}

const workers = []
function startWorker() {
  const { PHOTO_STORAGE: _storage, WORKER_EXPIRIES: _expiries, ...env } = process.env
  const child = spawn(process.execPath, ['dist/worker.js'], { env, stdio: ['ignore', 'ignore', 'inherit'] })
  workers.push(child)
  return child
}
async function stopWorker(child, signal) {
  const exited = once(child, 'exit')
  child.kill(signal)
  return (await exited)[1]
}
async function until(label, condition, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 50)) }
  assert.fail(`Tiempo agotado: ${label}`)
}
const unread = (page, count) => page.waitForFunction((expected) =>
  document.querySelector('a[href="/avisos"]')?.getAttribute('aria-label') === expected, `Avisos, ${count} sin leer`, { timeout: 25_000 })

try {
  const establishment = (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('Panadería K031 ${run}','Santiago',-33.45,-70.66,'America/Santiago') RETURNING id`)).rows[0].id
  const lotId = (await db.query(`INSERT INTO lots (establishment_id, description, category, quantity, address, latitude,
      longitude, time_zone, pickup_starts_at, pickup_ends_at, status, published_at)
    VALUES ($1, 'Pan del día K031', 'Panadería', 2, 'Santiago Centro', -33.45, -70.66, 'America/Santiago',
      now() - interval '1 hour', now() + interval '3 hours', 'published', now() - interval '2 hours')
    RETURNING public_id::text AS id`, [establishment])).rows[0].id
  const counters = async () => (await db.query(`SELECT free_quantity AS f, offered_quantity AS o, reserved_quantity AS r,
    expired_quantity AS x FROM lots WHERE public_id = $1`, [lotId])).rows[0]
  // Las cuentas se crean en secuencia: K008 limita scrypt a 2 a la vez.
  const people = await Promise.all(['Ana', 'Bea', 'Cata'].map(browserFor))
  const [ana, bea, cata] = people
  for (const person of people) {
    const email = `k031-${person.label.toLowerCase()}-${run}@example.com`
    assert.equal((await person.call('POST', '/auth/register', { email, password, privacyConsent: true })).status, 201)
    assert.equal((await person.call('POST', '/auth/login', { email, password })).status, 200)
  }
  let worker = startWorker()

  const reservation = await ana.call('POST', `/public/lots/${lotId}/reservations`, { quantity: 2, idempotencyKey: randomUUID() })
  assert.equal(reservation.status, 201)
  const beaEntry = (await bea.call('POST', `/public/lots/${lotId}/waitlist`, { quantity: 2, idempotencyKey: randomUUID() })).body
  const cataEntry = (await cata.call('POST', `/public/lots/${lotId}/waitlist`, { quantity: 2, idempotencyKey: randomUUID() })).body
  assert.deepEqual([beaEntry.status, beaEntry.position, cataEntry.status, cataEntry.position], ['waiting', 1, 'waiting', 2])
  await Promise.all([ana.page.goto(`${baseUrl}/reservas/${reservation.body.id}`), bea.page.goto(`${baseUrl}/espera/${beaEntry.id}`),
    cata.page.goto(`${baseUrl}/espera/${cataEntry.id}`)])
  await ana.page.locator('.pickup-code').waitFor()
  await bea.page.getByText('Tu posición en la cola: 1.', { exact: false }).waitFor()
  await cata.page.getByText('Tu posición en la cola: 2.', { exact: false }).waitFor()
  ok('Ana tiene la reserva con código; Bea espera primera y Cata segunda, cada una en su navegador')

  // Ana cancela en su navegador: los packs se ofrecen a Bea y el worker le genera el aviso.
  await ana.page.getByRole('button', { name: 'Cancelar reserva' }).click()
  await ana.page.getByRole('button', { name: 'Confirmar cancelación' }).click()
  await ana.page.getByText('Cancelación confirmada.', { exact: false }).waitFor()
  await bea.page.getByRole('button', { name: 'Aceptar explícitamente 2 packs' }).waitFor({ timeout: 25_000 })
  await unread(bea.page, 1)
  await cata.page.getByText('Tu posición en la cola: 1.', { exact: false }).waitFor({ timeout: 25_000 })
  assert.deepEqual(await counters(), { f: 0, o: 2, r: 0, x: 0 })
  ok('Ana cancela: la oferta llega a Bea (FIFO) con su aviso; Cata pasa a ser la primera sin oferta')

  // La oferta de Bea vence. El worker reclama el vencimiento y muere antes de registrarlo.
  assert.equal(await stopWorker(worker, 'SIGTERM'), null)
  await db.query(`UPDATE waitlist_entries SET offered_at = offered_at - interval '1 hour',
    offer_expires_at = offer_expires_at - interval '1 hour' WHERE public_id = $1`, [beaEntry.id])
  await db.query('BEGIN')
  await db.query('SELECT 1 FROM waitlist_entries WHERE public_id = $1 FOR UPDATE', [beaEntry.id])
  worker = startWorker()
  await until('worker bloqueado en el vencimiento', async () => (await observer.query(`SELECT 1 FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%waitlist_entries%'`)).rowCount > 0)
  assert.equal(await stopWorker(worker, 'SIGKILL'), 'SIGKILL')
  await db.query('COMMIT')
  await bea.page.getByText('No puedes aceptar una oferta vencida', { exact: false }).waitFor({ timeout: 25_000 })
  assert.equal(await bea.page.getByRole('button', { name: /Aceptar explícitamente/ }).count(), 0)
  assert.deepEqual((await db.query('SELECT status FROM waitlist_entries WHERE public_id = ANY($1) ORDER BY id',
    [[beaEntry.id, cataEntry.id]])).rows.map((row) => row.status), ['offered', 'waiting'])
  ok('worker muerto tras reclamar: Bea ve su oferta vencida y no puede aceptarla; nada quedó a medias y Cata sigue sin oferta')

  // Reiniciado al vencer la concesión, el worker registra el vencimiento y ofrece a Cata.
  await db.query('UPDATE lots SET expiry_claimed_until = now() WHERE public_id = $1', [lotId])
  worker = startWorker()
  await cata.page.getByRole('button', { name: 'Aceptar explícitamente 2 packs' }).waitFor({ timeout: 25_000 })
  await unread(cata.page, 1)
  await unread(bea.page, 2)
  assert.deepEqual(await counters(), { f: 0, o: 2, r: 0, x: 0 })
  ok('worker reiniciado: retoma el lote, la oferta pasa a Cata y cada una recibe su aviso')

  // Cata entra por su aviso, acepta y ve su código de retiro.
  await cata.page.getByRole('link', { name: /^Avisos/ }).click()
  await cata.page.getByRole('article', { name: 'Tienes una oferta por 2 packs' }).getByRole('button', { name: 'Ver oferta' }).click()
  await cata.page.getByRole('button', { name: 'Aceptar explícitamente 2 packs' }).click()
  await cata.page.getByText('Oferta aceptada', { exact: true }).waitFor()
  await cata.page.getByRole('link', { name: 'Consultar mi reserva y código de retiro' }).click()
  await cata.page.locator('.pickup-code').waitFor()
  await bea.page.getByRole('link', { name: /^Avisos/ }).click()
  await bea.page.getByRole('article', { name: 'Tu oferta venció' }).getByRole('button', { name: 'Ver solicitud' }).click()
  await bea.page.getByText('No puedes aceptar una oferta vencida', { exact: false }).waitFor()
  assert.deepEqual(await counters(), { f: 0, o: 0, r: 2, x: 0 })
  ok('Cata acepta desde su aviso y obtiene el código; Bea abre el suyo y la oferta sigue vencida')

  const notices = async () => (await db.query(`SELECT e.event_type, count(n.id)::int AS n FROM outbox_events e
    LEFT JOIN notifications n ON n.event_id = e.id WHERE (e.payload->'lot'->>'id') = $1 GROUP BY e.id ORDER BY e.id`, [lotId]))
    .rows.map((row) => [row.event_type, row.n])
  await until('aviso de la reserva de Cata', async () => (await notices()).at(-1)?.[1] === 1)
  assert.deepEqual(await notices(), [['reservation_cancelled', 1], ['offer_issued', 1],
    ['offer_expired', 1], ['offer_issued', 1], ['reservation_confirmed', 1]])
  for (const person of people) assert.deepEqual(person.errors, [])
  ok('stock F=0 O=0 R=2 y un aviso por evento: ninguna oferta ni aviso duplicado')
  console.log('K031 web queue worker: three browsers, real worker kill -9 and restart, FIFO offer, inbox and stock checks passed')
} finally {
  for (const child of workers) if (child.exitCode === null && child.signalCode === null) await stopWorker(child, 'SIGTERM')
  await db.query('ROLLBACK').catch(() => {})
  await Promise.all(contexts.map((context) => context.close()))
  await browser.close()
  await db.end()
  await observer.end()
}
