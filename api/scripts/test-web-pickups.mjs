import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { chromium } from 'playwright'

// K024: validación de retiro del operador contra Vite HTTPS → proxy → API → PostgreSQL. Requiere
// servicios iniciados; DATABASE_URL habilita memberships ficticias y simula el cierre de un lote.
const baseUrl = (process.env.WEB_URL ?? 'https://localhost:5174').replace(/\/$/, '')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL debe apuntar a la base de prueba usada por la API')
const password = 'K024-pickup-validation-password'
const run = Date.now()
const hour = 3600000
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const browser = await chromium.launch({ headless: true })
const contexts = []
const ok = (message) => console.log(`✓ ${message}`)
// K008 limita por usuario (ráfaga 20, 2/s) y cuenta también las lecturas: recuperar la ráfaga completa.
const refillUserQuota = (page) => page.waitForTimeout(10_000)

/** Cuenta propia (cuota de límite propia); su contexto comparte cookies entre API y navegador. */
async function account(label) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: 'America/Santiago', viewport: { width: 1366, height: 768 } })
  contexts.push(context)
  const email = `k024-${label}-${run}@example.com`
  const call = async (method, path, data) => {
    const session = await (await context.request.get(`${baseUrl}/api/auth/session`)).json()
    const response = await context.request.fetch(`${baseUrl}/api${path}`, {
      method, data, headers: { Origin: baseUrl, 'X-CSRF-Token': session.csrfToken },
    })
    return { status: response.status(), body: response.status() === 204 ? null : await response.json() }
  }
  assert.equal((await call('POST', '/auth/register', { email, password, privacyConsent: true })).status, 201)
  assert.equal((await call('POST', '/auth/login', { email, password })).status, 200)
  const userId = (await db.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id
  return { context, call, userId }
}

async function publishLot(operator, establishment, startsInMs, endsInMs) {
  const created = await operator.call('POST', `/establishments/${establishment}/lots`, {
    description: `Pack de prueba K024 ${randomUUID().slice(0, 8)}`, category: 'Panadería', quantity: 10,
    address: 'Calle de Ejemplo 123, Santiago', latitude: -33.45, longitude: -70.66, timeZone: 'America/Santiago',
    pickupStartsAt: new Date(Date.now() + startsInMs).toISOString(), pickupEndsAt: new Date(Date.now() + endsInMs).toISOString(),
  })
  assert.equal(created.status, 201)
  assert.equal((await operator.call('POST', `/lots/${created.body.id}/publish`, { version: 1 })).status, 200)
  return created.body.id
}

async function reserve(rescuer, lotId, quantity = 2) {
  const reserved = await rescuer.call('POST', `/public/lots/${lotId}/reservations`, { quantity, idempotencyKey: randomUUID() })
  assert.equal(reserved.status, 201)
  const detail = await rescuer.call('GET', `/reservations/${reserved.body.id}`)
  assert.match(detail.body.pickupCode, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  return { id: reserved.body.id, code: detail.body.pickupCode }
}

async function waitForApiResponse(page, pattern, method, action) {
  const response = page.waitForResponse((item) => pattern.test(new URL(item.url()).pathname) && item.request().method() === method)
  await action()
  return response
}

try {
  const establishment = (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('Panadería K024 ${run}','Dirección ficticia',-33.45,-70.66,'America/Santiago') RETURNING id,public_id`)).rows[0]
  // Una cuenta publica los lotes y otra opera la pantalla: cada una con su propia cuota por usuario.
  const publisher = await account('publicador')
  const operator = await account('operador')
  for (const member of [publisher, operator]) {
    await db.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)', [member.userId, establishment.id])
  }
  // En secuencia: K008 admite dos cálculos de scrypt simultáneos y responde 503 al saturarse.
  const rescuers = []
  for (const label of ['ana', 'beto', 'carla', 'diego']) rescuers.push(await account(label))
  const [rescuerA, rescuerB, rescuerC, rescuerD] = rescuers

  const openLot = await publishLot(publisher, establishment.public_id, -hour, 3 * hour)
  const futureLot = await publishLot(publisher, establishment.public_id, 24 * hour, 27 * hour)
  const closingLot = await publishLot(publisher, establishment.public_id, -2 * hour, hour)
  const delivered = await reserve(rescuerA, openLot)
  const cancelledLater = await reserve(rescuerB, openLot, 1)
  const early = await reserve(rescuerC, futureLot)
  const expired = await reserve(rescuerD, closingLot)
  ok('preparación: dos cuentas con membership, tres lotes publicados y cuatro reservas reales con código')

  // Acceso denegado: otra cuenta sin membership sobre el establecimiento.
  const outsider = await account('ajeno')
  const outsiderPage = await outsider.context.newPage()
  await outsiderPage.goto(`${baseUrl}/operador/lotes/${openLot}/retiros`)
  await outsiderPage.getByRole('alert').filter({ hasText: 'Acceso denegado' }).waitFor()
  assert.equal(await outsiderPage.locator('input[name="pickupCode"]').count(), 0)
  ok('acceso denegado: una cuenta sin membership no ve el formulario de retiro')

  const page = await operator.context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const rateLimited = []
  page.on('response', (response) => { if (response.status() === 429) rateLimited.push(new URL(response.url()).pathname) })
  const commands = []
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if (/\/pickup(s|-reviews)$/.test(pathname)) commands.push({ path: pathname, body: request.postDataJSON() })
  })
  const codeInput = page.locator('input[name="pickupCode"]')
  const reviewButton = page.getByRole('button', { name: 'Revisar código' })
  const review = (code) => waitForApiResponse(page, /\/pickup-reviews$/, 'POST', async () => { await codeInput.fill(code); await reviewButton.click() })

  await page.goto(`${baseUrl}/operador/lotes`)
  await page.getByRole('link', { name: 'Validar retiros' }).first().waitFor()
  await page.goto(`${baseUrl}/operador/lotes/${openLot}/retiros`)
  await page.getByRole('heading', { name: 'Validar retiros' }).waitFor()

  assert.equal((await review('ZZZZZZZZ')).status(), 404)
  await page.getByRole('alert').filter({ hasText: 'no corresponde a una reserva de este lote' }).waitFor()
  ok('código inexistente: 404 explicado sin más información')

  // El servidor ignora guiones, espacios y mayúsculas: se dicta como lo muestra la persona.
  const spoken = `${delivered.code.slice(0, 4).toLowerCase()}-${delivered.code.slice(4)}`
  assert.equal((await review(spoken)).status(), 200)
  await page.getByText('La reserva está vigente').waitFor()
  assert.equal(await codeInput.inputValue(), '')
  const visible = await page.locator('main').innerText()
  assert.ok(!visible.toUpperCase().includes(delivered.code), 'el código no se muestra en la revisión')
  const confirmButton = page.getByRole('button', { name: 'Confirmar retiro de 2 packs' })
  const confirmed = await waitForApiResponse(page, /\/pickups$/, 'POST', () => confirmButton.dblclick())
  assert.equal(confirmed.status(), 201)
  await page.getByText('Retiro registrado: 2 packs entregados').waitFor()
  const pickupCommands = commands.filter((item) => item.path.endsWith('/pickups'))
  assert.equal(pickupCommands.length, 1)
  assert.equal(pickupCommands[0].body.reservationId, delivered.id)
  assert.match(pickupCommands[0].body.idempotencyKey, /^[0-9a-f-]{36}$/)
  ok('revisar y confirmar: código normalizado, sin mostrarse, un solo POST ante doble clic → 201')

  assert.equal((await review(delivered.code)).status(), 200)
  await page.getByText('Esta reserva ya se retiró').waitFor()
  assert.equal(await page.getByRole('button', { name: /Confirmar retiro/ }).count(), 0)
  ok('código usado: la revisión muestra «Retirada» y no ofrece confirmar')

  // Criterio: revisar antes de una cancelación no permite entregar después.
  assert.equal((await review(cancelledLater.code)).status(), 200)
  await page.getByText('La reserva está vigente').waitFor()
  assert.equal((await rescuerB.call('POST', `/reservations/${cancelledLater.id}/cancel`, {})).status, 200)
  const rejected = await waitForApiResponse(page, /\/pickups$/, 'POST', () => page.getByRole('button', { name: 'Confirmar retiro de 1 pack' }).click())
  assert.equal(rejected.status(), 409)
  await page.getByText('La reserva cambió desde la revisión').waitFor()
  await page.getByText('El titular canceló esta reserva').waitFor()
  assert.equal(await page.getByRole('button', { name: /Confirmar retiro/ }).count(), 0)
  const delivery = await db.query(`SELECT count(*)::int AS n FROM deliveries d JOIN commitments c ON c.id = d.commitment_id WHERE c.public_id = $1`, [cancelledLater.id])
  assert.equal(delivery.rows[0].n, 0)
  ok('revisión previa + cancelación: confirmar responde 409, se vuelve a revisar y muestra «Cancelada»; sin entrega')

  await page.locator('.pickups').scrollIntoViewIfNeeded()
  for (const viewport of [{ width: 360, height: 800 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.screenshot({ path: `/tmp/rescate-k024-${viewport.width}x${viewport.height}.png`, fullPage: true })
  }
  ok('layout sin scroll horizontal en 360×800 y 1366×768')

  await refillUserQuota(page)
  await page.goto(`${baseUrl}/operador/lotes/${futureLot}/retiros`)
  await page.getByText('La ventana de retiro comienza').waitFor()
  assert.equal((await review(early.code)).status(), 200)
  await page.getByText('La ventana de retiro aún no comienza').waitFor()
  assert.equal(await page.getByRole('button', { name: /Confirmar retiro/ }).count(), 0)
  ok('ventana sin comenzar: se puede revisar, pero no confirmar')

  // Simula el cierre del lote sin esperar horas: la API trata la reserva como vencida.
  await db.query(`UPDATE lots SET pickup_starts_at = now() - interval '3 hours', pickup_ends_at = now() - interval '1 minute' WHERE public_id = $1`, [closingLot])
  await page.goto(`${baseUrl}/operador/lotes/${closingLot}/retiros`)
  await page.getByText('El lote está cerrado').waitFor()
  assert.equal((await review(expired.code)).status(), 200)
  await page.getByText('La reserva venció').waitFor()
  assert.equal(await page.getByRole('button', { name: /Confirmar retiro/ }).count(), 0)
  ok('lote cerrado: aviso en el encabezado y la reserva figura «Vencida»')

  const reviewBodies = commands.filter((item) => item.path.endsWith('/pickup-reviews'))
  assert.ok(reviewBodies.every((item) => typeof item.body.code === 'string'), 'el código viaja en el cuerpo')
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
  for (const item of [delivered, cancelledLater, early, expired]) {
    assert.ok(!page.url().includes(item.code) && !storage.includes(item.code), 'el código no queda en la URL ni en el almacenamiento')
  }
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(rateLimited, [], 'la prueba no debe depender de respuestas 429')
  ok('privacidad: códigos solo en cuerpos POST; nunca en URL ni almacenamiento del navegador')

  console.log('K024 web pickups: real API, proxy, CSRF, review, confirm, cancellation race, closed lot and access checks passed')
} finally {
  await Promise.all(contexts.map((context) => context.close()))
  await browser.close()
  await db.end()
}
