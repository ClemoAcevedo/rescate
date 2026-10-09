// Navegador real → Vite HTTPS → API → PostgreSQL migrado.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { chromium } from 'playwright'

const base = (process.env.WEB_URL ?? 'https://localhost:5173').replace(/\/$/, '')
assert.ok(process.env.DATABASE_URL && /^rescate_(k015_test_|web_test_)/.test(new URL(process.env.DATABASE_URL).pathname.slice(1)),
  'Se requiere la base temporal K015 o web')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce', viewport: { width: 1366, height: 768 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  const title = `Pack navegador K015 ${randomUUID().slice(0, 8)}`
  const estate = await db.query(`INSERT INTO establishments
    (name, address, latitude, longitude, time_zone) VALUES ('K015 Web', 'Santiago', -33.45, -70.66, 'America/Santiago') RETURNING id`)
  const created = await db.query(`INSERT INTO lots
    (establishment_id, description, category, quantity, address, latitude, longitude, time_zone,
     pickup_starts_at, pickup_ends_at, status, published_at)
    VALUES ($1, $2, 'Panadería', 3, 'Santiago Centro', -33.45, -70.66,
      'America/Santiago', now() + interval '1 hour', now() + interval '3 hours', 'published', now())
    RETURNING public_id::text AS id`, [estate.rows[0].id, title])
  const lotId = created.rows[0].id
  const soldOutTitle = `Pack agotado K016 ${randomUUID().slice(0, 8)}`
  const soldOut = await db.query(`INSERT INTO lots
    (establishment_id, description, category, quantity, address, latitude, longitude, time_zone,
     pickup_starts_at, pickup_ends_at, status, published_at)
    VALUES ($1, $2, 'Panadería', 1, 'Santiago Centro', -33.45, -70.66,
      'America/Santiago', now() + interval '1 hour', now() + interval '3 hours', 'published', now())
    RETURNING id`, [estate.rows[0].id, soldOutTitle])
  const soldOutUser = await db.query('INSERT INTO users(email) VALUES ($1) RETURNING id',
    [`sold-out-${randomUUID()}@example.invalid`])
  // Fixture directo: la reserva y su movimiento F → R van juntos, como en la API.
  await db.query(`WITH moved AS (UPDATE lots SET reserved_quantity = reserved_quantity + 1 WHERE id = $2 RETURNING id)
    INSERT INTO commitments (user_id, lot_id, quantity, status)
    SELECT $1, id, 1, 'confirmed' FROM moved`, [soldOutUser.rows[0].id, soldOut.rows[0].id])
  await page.goto(`${base}/lotes`)
  await page.getByText(title).waitFor()
  assert.equal(await page.getByText('Fotografía no disponible').count() > 0, true)
  const soldOutCard = page.locator('article').filter({ hasText: soldOutTitle })
  await soldOutCard.getByText('Sin stock', { exact: true }).waitFor()
  await soldOutCard.getByRole('link', { name: soldOutTitle }).click()
  await page.getByRole('heading', { name: soldOutTitle }).waitFor()
  await page.getByText('Sin stock disponible').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Confirmar reserva' }).count(), 0)
  await page.getByText('No quedan packs libres.').waitFor()
  await page.getByRole('link', { name: 'Volver a explorar lotes' }).click()
  await page.getByText(title).waitFor()
  console.log('OK: lote agotado visible en lista y detalle, sin envío de reserva')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  const zone = page.locator('.explore-zone')
  assert.equal(await zone.evaluate(element => element.open), false)
  await zone.locator('summary').focus()
  await page.keyboard.press('Enter')
  assert.equal(await zone.evaluate(element => element.open), true)
  await page.keyboard.press('Tab')
  assert.equal(await page.getByLabel('Latitud de la zona', { exact: true }).evaluate(element => element === document.activeElement), true)
  await page.getByLabel('Latitud de la zona', { exact: true }).fill('999')
  await zone.locator('summary').click()
  await page.getByRole('button', { name: 'Buscar lotes' }).click()
  assert.equal(await zone.evaluate(element => element.open), true, 'Un campo inválido oculto vuelve a estar visible')
  await page.getByLabel('Latitud de la zona', { exact: true }).fill('')
  console.log('OK: zona manual accesible con teclado y validación visible al cerrar filtros')
  await page.setViewportSize({ width: 360, height: 740 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  console.log('OK: visitante ve lote real y fotografía de reemplazo')

  await context.clearPermissions()
  await page.getByRole('button', { name: 'Usar mi ubicación' }).click()
  await page.getByText('No se obtuvo tu ubicación').waitFor()
  await page.getByLabel('Categoría', { exact: true }).fill('Panadería')
  await page.getByLabel('Latitud de la zona', { exact: true }).fill('-33.45')
  await page.getByLabel('Longitud de la zona', { exact: true }).fill('-70.66')
  await page.getByLabel('Radio (km)', { exact: true }).fill('5')
  await page.getByRole('button', { name: 'Buscar lotes' }).click()
  await page.getByText(title).waitFor()
  assert.match(page.url(), /latitude=-33.45/)
  console.log('OK: geolocalización denegada no impide búsqueda manual')
  await page.getByLabel('Categoría', { exact: true }).fill('Sin coincidencias K015')
  await page.getByRole('button', { name: 'Buscar lotes' }).click()
  await page.getByText('No se encontraron lotes con estos filtros.').waitFor()
  await page.getByRole('button', { name: 'Ver todos los lotes' }).click()
  await page.getByText(title).waitFor()
  assert.equal(new URL(page.url()).search, '')
  await page.goBack()
  await page.getByText('No se encontraron lotes con estos filtros.').waitFor()
  await page.goBack()
  await page.getByText(title).waitFor()
  assert.equal(await page.getByLabel('Categoría', { exact: true }).inputValue(), 'Panadería',
    'El formulario debe seguir los filtros de la URL al volver atrás')
  console.log('OK: volver atrás sincroniza filtros y resultados')

  await page.locator('article').filter({ hasText: title })
    .getByRole('link', { name: title }).click()
  await page.getByRole('heading', { name: title }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.setViewportSize({ width: 1366, height: 768 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: '/tmp/rescate-k015-detail-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 360, height: 740 })
  await page.screenshot({ path: '/tmp/rescate-k015-detail-mobile.png', fullPage: true })
  const detailUrl = page.url()
  assert.match(detailUrl, new RegExp(lotId))
  await page.getByRole('link', { name: 'Inicia sesión para reservar' }).click()
  const email = `k015-web-${randomUUID()}@example.invalid`
  const password = 'Clave-ficticia-K015-web-segura'
  const registration = await page.evaluate(async ({ email, password }) => {
    const { csrfToken } = await (await fetch('/api/auth/session')).json()
    return (await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ email, password, privacyConsent: true }) })).status
  }, { email, password })
  assert.equal(registration, 201)
  await page.locator('input[name="email"]').fill(email)
  await page.locator('input[name="password"]').fill(password)
  await page.getByRole('button', { name: 'Iniciar sesión' }).click()
  await page.waitForURL(detailUrl)
  await page.getByRole('heading', { name: 'Solicitar packs' }).waitFor()
  await page.getByRole('button', { name: 'Agregar un pack' }).click()
  assert.equal(await page.getByRole('spinbutton', { name: 'Cantidad de packs' }).inputValue(), '2')
  await page.getByRole('button', { name: 'Quitar un pack' }).click()
  assert.equal(await page.getByRole('spinbutton', { name: 'Cantidad de packs' }).inputValue(), '1')
  assert.equal(await page.getByRole('button', { name: 'Quitar un pack' }).isDisabled(), true)
  // Otra persona consume un pack después de la lectura mostrada en pantalla.
  const another = await db.query('INSERT INTO users(email) VALUES ($1) RETURNING id', [`race-${randomUUID()}@example.invalid`])
  await db.query(`WITH moved AS (UPDATE lots SET reserved_quantity = reserved_quantity + 1 WHERE public_id = $2 RETURNING id)
    INSERT INTO commitments (user_id, lot_id, quantity, status)
    SELECT $1, id, 1, 'confirmed' FROM moved`, [another.rows[0].id, lotId])
  const attempts = []
  await page.route(`**/public/lots/${lotId}/reservations`, async route => {
    attempts.push(route.request().postDataJSON())
    if (attempts.length === 1) {
      const committed = await route.fetch()
      assert.equal(committed.status(), 201)
      await route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' }) // Commit confirmado; el proxy pierde la respuesta.
    } else await route.continue()
  })
  await page.getByRole('button', { name: 'Confirmar reserva' }).click()
  await page.getByText('Reserva confirmada por 1 pack').waitFor()
  await page.getByText('1 pack libre', { exact: true }).waitFor()
  assert.equal(await page.locator('.reservation-confirmation').evaluate(element => element === document.activeElement), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[0], attempts[1])
  assert.equal((await db.query('SELECT count(*)::int n FROM commitments WHERE lot_id=(SELECT id FROM lots WHERE public_id=$1)', [lotId])).rows[0].n, 2)
  console.log('OK: 502 HTML tras commit se recupera sin duplicar; disponibilidad se relee ante reservas ajenas')
  await page.reload()
  await page.getByText('1 pack libre').waitFor()
  assert.deepEqual(errors, [])
  console.log('OK: login vuelve al detalle y confirma reserva con API real')
} finally {
  await browser.close()
  await db.end()
}
