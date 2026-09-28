// Navegador real → Vite HTTPS → API → PostgreSQL migrado.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { chromium } from 'playwright'

const base = (process.env.WEB_URL ?? 'https://localhost:5173').replace(/\/$/, '')
assert.ok(process.env.DATABASE_URL && /^rescate_(k016_test|web_test_)/.test(new URL(process.env.DATABASE_URL).pathname.slice(1)),
  'Se requiere la base temporal K016 o web')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 768 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  const title = `Pack navegador K016 ${randomUUID().slice(0, 8)}`
  const estate = await db.query(`INSERT INTO establishments
    (name, address, latitude, longitude, time_zone) VALUES ('K016 Web', 'Santiago', -33.45, -70.66, 'America/Santiago') RETURNING id`)
  const created = await db.query(`INSERT INTO lots
    (establishment_id, description, category, quantity, address, latitude, longitude, time_zone,
     pickup_starts_at, pickup_ends_at, status, published_at)
    VALUES ($1, $2, 'Panadería', 2, 'Santiago Centro', -33.45, -70.66,
      'America/Santiago', now() + interval '1 hour', now() + interval '3 hours', 'published', now())
    RETURNING public_id::text AS id`, [estate.rows[0].id, title])
  const lotId = created.rows[0].id
  await page.goto(`${base}/lotes`)
  await page.getByText(title).waitFor()
  assert.equal(await page.getByText('Fotografía no disponible').count() > 0, true)
  await page.setViewportSize({ width: 360, height: 740 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  console.log('OK: visitante ve lote real y fotografía de reemplazo')

  await context.clearPermissions()
  await page.getByRole('button', { name: 'Usar mi ubicación' }).click()
  await page.getByText('No se obtuvo tu ubicación').waitFor()
  const fields = page.locator('.explore-filters__form input')
  await fields.nth(0).fill('Panadería')
  await fields.nth(1).fill('-33.45')
  await fields.nth(2).fill('-70.66')
  await fields.nth(3).fill('5')
  await page.getByRole('button', { name: 'Buscar lotes' }).click()
  await page.getByText(title).waitFor()
  assert.match(page.url(), /latitude=-33.45/)
  console.log('OK: geolocalización denegada no impide búsqueda manual')

  await page.locator('article').filter({ hasText: title })
    .getByRole('link', { name: 'Ver detalle del lote' }).click()
  await page.getByRole('heading', { name: title }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  const detailUrl = page.url()
  assert.match(detailUrl, new RegExp(lotId))
  await page.getByRole('link', { name: 'inicia sesión' }).click()
  const email = `k016-web-${randomUUID()}@example.invalid`
  const password = 'Clave-ficticia-K016-web-segura'
  const registration = await page.evaluate(async ({ email, password }) => {
    const { csrfToken } = await (await fetch('/api/auth/session')).json()
    return (await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ email, password }) })).status
  }, { email, password })
  assert.equal(registration, 201)
  await page.locator('input[name="email"]').fill(email)
  await page.locator('input[name="password"]').fill(password)
  await page.getByRole('button', { name: 'Iniciar sesión' }).click()
  await page.waitForURL(detailUrl)
  await page.getByRole('heading', { name: 'Solicitar packs' }).waitFor()
  await page.getByRole('button', { name: 'Confirmar reserva' }).click()
  await page.getByText('Reserva confirmada por 1 pack').waitFor()
  await page.reload()
  await page.getByText('1 pack libre').waitFor()
  assert.deepEqual(errors, [])
  console.log('OK: login vuelve al detalle y confirma reserva con API real')
} finally {
  await browser.close()
  await db.end()
}
