import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { chromium } from 'playwright'

// K030: bandeja de avisos contra Vite HTTPS → proxy → API → PostgreSQL, con el worker real
// generando los avisos del outbox. Requiere servicios iniciados (test:web:compose los levanta).
const baseUrl = (process.env.WEB_URL ?? 'https://localhost:5174').replace(/\/$/, '')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL debe apuntar a la base de prueba usada por la API y el worker')
const password = 'K030-notifications-password'
const run = Date.now()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const browser = await chromium.launch({ headless: true })
const contexts = []
const ok = (message) => console.log(`✓ ${message}`)

/** Cuenta propia en su contexto; las cuentas se crean en secuencia (K008 limita scrypt a 2 a la vez). */
async function account(label) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: 'America/Santiago', viewport: { width: 1366, height: 768 } })
  contexts.push(context)
  const email = `k030-${label}-${run}@example.com`
  const call = async (method, path, data) => {
    const session = await (await context.request.get(`${baseUrl}/api/auth/session`)).json()
    const response = await context.request.fetch(`${baseUrl}/api${path}`, { method, data, headers: { Origin: baseUrl, 'X-CSRF-Token': session.csrfToken } })
    return { status: response.status(), body: response.status() === 204 ? null : await response.json() }
  }
  assert.equal((await call('POST', '/auth/register', { email, password, privacyConsent: true })).status, 201)
  assert.equal((await call('POST', '/auth/login', { email, password })).status, 200)
  return { context, call }
}

try {
  const establishment = (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('Avisos K030 ${run}','Santiago',-33.45,-70.66,'America/Santiago') RETURNING id`)).rows[0].id
  const lotId = (await db.query(`INSERT INTO lots (establishment_id, description, category, quantity, address, latitude,
      longitude, time_zone, pickup_starts_at, pickup_ends_at, status, published_at)
    VALUES ($1, 'Pan del día K030', 'Panadería', 1, 'Santiago Centro', -33.45, -70.66, 'America/Santiago',
      now() - interval '1 hour', now() + interval '3 hours', 'published', now() - interval '2 hours')
    RETURNING public_id::text AS id`, [establishment])).rows[0].id
  const ana = await account('ana')
  const bea = await account('bea')
  const cata = await account('cata')

  const reserved = await ana.call('POST', `/public/lots/${lotId}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })
  assert.equal(reserved.status, 201)
  const entry = await bea.call('POST', `/public/lots/${lotId}/waitlist`, { quantity: 1, idempotencyKey: randomUUID() })
  assert.equal(entry.body.status, 'waiting')

  const page = await bea.context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const rateLimited = []
  page.on('response', (response) => { if (response.status() === 429) rateLimited.push(new URL(response.url()).pathname) })
  const inboxLink = page.getByRole('link', { name: /^Avisos/ })
  await page.goto(`${baseUrl}/reservas`)
  await inboxLink.waitFor()
  assert.equal(await inboxLink.getAttribute('aria-label'), 'Avisos')
  ok('sin avisos: la cabecera muestra «Avisos» sin contador')

  // Ana cancela: la oferta para Bea nace con la transición y el worker genera el aviso.
  assert.equal((await ana.call('POST', `/reservations/${reserved.body.id}/cancel`, {})).status, 200)
  await page.waitForFunction(() => document.querySelector('a[href="/avisos"]')?.getAttribute('aria-label') === 'Avisos, 1 sin leer',
    null, { timeout: 25_000 })
  ok('la oferta emitida llega a la cabecera por la consulta periódica (≤ 15 s con la pestaña visible)')

  // Sin conexión, la oferta vence y otra persona reserva el pack liberado; al reconectar se recupera de inmediato.
  await bea.context.setOffline(true)
  await db.query(`UPDATE waitlist_entries SET offered_at = now() - interval '20 minutes',
    offer_expires_at = now() - interval '10 minutes' WHERE public_id = $1`, [entry.body.id])
  // Reservar asienta la cola bajo el bloqueo: registra el vencimiento de Bea y luego asigna el pack libre.
  const cataReservation = await cata.call('POST', `/public/lots/${lotId}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })
  assert.equal(cataReservation.status, 201)
  await page.waitForTimeout(3_000)
  const reconnectedAt = Date.now()
  await bea.context.setOffline(false)
  await page.waitForFunction(() => document.querySelector('a[href="/avisos"]')?.getAttribute('aria-label') === 'Avisos, 2 sin leer',
    null, { timeout: 10_000 })
  const recovered = Date.now() - reconnectedAt
  assert.ok(recovered < 10_000)
  ok(`desconectada: el aviso de vencimiento persiste y se recupera al reconectar (${recovered} ms)`)

  await inboxLink.click()
  await page.waitForURL(`${baseUrl}/avisos`)
  await page.getByText('2 avisos sin leer.').waitFor()
  const expiredCard = page.getByRole('article', { name: 'Tu oferta venció' })
  const offerCard = page.getByRole('article', { name: 'Tienes una oferta por 1 pack' })
  await expiredCard.getByText('Nuevo', { exact: true }).waitFor()
  await offerCard.getByText('Nuevo', { exact: true }).waitFor()
  assert.equal(await page.getByRole('article').count(), 2)
  ok('la bandeja lista oferta y vencimiento, ambos sin leer')

  for (const viewport of [{ width: 360, height: 800 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.screenshot({ path: `/tmp/rescate-k030-${viewport.width}x${viewport.height}.png`, fullPage: true })
  }
  ok('layout sin scroll horizontal en 360×800 y 1366×768')

  // Abrir el aviso de la oferta registra la lectura y lleva al estado vigente: vencida, sin aceptar.
  const read = page.waitForResponse((response) => /\/api\/notifications\/[^/]+\/read$/.test(new URL(response.url()).pathname))
  await offerCard.getByRole('button', { name: 'Ver oferta' }).click()
  assert.equal((await read).status(), 200)
  await page.waitForURL(`${baseUrl}/espera/${entry.body.id}`)
  await page.getByText('No puedes aceptar una oferta vencida').waitFor()
  assert.equal(await page.getByRole('button', { name: /Aceptar explícitamente/ }).count(), 0)
  assert.equal((await db.query('SELECT status FROM waitlist_entries WHERE public_id = $1', [entry.body.id])).rows[0].status, 'expired')
  await page.waitForFunction(() => document.querySelector('a[href="/avisos"]')?.getAttribute('aria-label') === 'Avisos, 1 sin leer')
  ok('leer el aviso de una oferta antigua no la reactiva: el detalle la muestra vencida y sin aceptar')

  await inboxLink.click()
  await page.getByText('1 aviso sin leer.').waitFor()
  assert.equal(await offerCard.getByText('Nuevo', { exact: true }).count(), 0)
  ok('al volver, la oferta figura leída y el contador baja a 1')

  // Cada persona ve solo sus avisos: Ana su cancelación; Cata reservó directo y no recibe avisos en K030.
  const anaPage = await ana.context.newPage()
  await anaPage.goto(`${baseUrl}/avisos`)
  await anaPage.getByRole('article', { name: 'Reserva cancelada' }).waitFor({ timeout: 20_000 })
  assert.equal(await anaPage.getByRole('article').count(), 1)
  const counts = await db.query(`SELECT kind, count(*)::int AS n FROM notifications n JOIN outbox_events e ON e.id = n.event_id
    WHERE (e.payload->'lot'->>'id') = $1 GROUP BY kind ORDER BY kind`, [lotId])
  assert.deepEqual(counts.rows, [{ kind: 'offer_expired', n: 1 }, { kind: 'offer_issued', n: 1 }, { kind: 'reservation_cancelled', n: 1 }])
  ok('cada bandeja muestra solo lo propio; un aviso por evento y destinatario')

  assert.deepEqual(pageErrors, [])
  assert.deepEqual(rateLimited, [], 'la prueba no debe depender de respuestas 429')
  console.log('K030 web notifications: real API, worker, proxy, CSRF, polling, reconnect, read and permissions checks passed')
} finally {
  await Promise.all(contexts.map((context) => context.close()))
  await browser.close()
  await db.end()
}
