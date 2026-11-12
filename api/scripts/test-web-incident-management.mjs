import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { chromium } from './support/browser.mjs'

// K046: gestión de incidencias del operador y reporte de quien reservó contra Vite HTTPS →
// proxy → API → PostgreSQL, con el worker real generando los avisos. DATABASE_URL crea las
// memberships ficticias, igual que el panel.
const baseUrl = (process.env.WEB_URL ?? 'https://localhost:5174').replace(/\/$/, '')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL debe apuntar a la base de prueba usada por la API')
const password = 'K046-incidencias-password-segura'
const run = Date.now()
const hour = 3600000
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const browser = await chromium.launch({ headless: true })
const contexts = []
const ok = (message) => console.log(`✓ ${message}`)
// K008 limita por usuario (ráfaga 20, 2/s) y cuenta también las lecturas: recuperar la ráfaga completa.
const refillUserQuota = (page) => page.waitForTimeout(10_000)
const pageErrors = []
const rateLimited = []
function watch(page) {
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('response', (response) => { if (response.status() === 429) rateLimited.push(new URL(response.url()).pathname) })
  return page
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

async function account(label, viewport = { width: 1366, height: 768 }) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: 'America/Santiago', viewport })
  contexts.push(context)
  const email = `k046-${label}-${run}@example.com`
  const call = async (method, path, data) => {
    const session = await (await context.request.get(`${baseUrl}/api/auth/session`)).json()
    const response = await context.request.fetch(`${baseUrl}/api${path}`, {
      method, data, headers: { Origin: baseUrl, 'X-CSRF-Token': session.csrfToken },
    })
    return { status: response.status(), body: response.status() === 204 ? null : await response.json() }
  }
  assert.equal((await call('POST', '/auth/register', { email, password, privacyConsent: true })).status, 201)
  // CI lo corre en su propia invocación de test:web:compose: toda la suite comparte el límite de
  // login por IP (30 cada 15 min). Si se encadena tras otros recorridos, espera el Retry-After.
  for (let attempt = 0; ; attempt++) {
    const session = await (await context.request.get(`${baseUrl}/api/auth/session`)).json()
    const login = await context.request.post(`${baseUrl}/api/auth/login`, {
      data: { email, password }, headers: { Origin: baseUrl, 'X-CSRF-Token': session.csrfToken },
    })
    if (login.status() === 200) break
    assert.ok(login.status() === 429 && attempt < 3, `login ${login.status()}`)
    const wait = Number(login.headers()['retry-after'])
    assert.ok(wait > 0 && wait <= 900, 'Retry-After dentro de la ventana de login')
    console.log(`… límite de login por IP: espera ${wait} s`)
    await new Promise((resolve) => setTimeout(resolve, wait * 1000 + 500))
  }
  const userId = (await db.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id
  return { context, call, email, userId }
}

try {
  const establishment = async (name) => (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ($1,'Dirección ficticia',-33.45,-70.66,'America/Santiago') RETURNING id,public_id`, [name])).rows[0]
  const north = await establishment(`Panadería K046 ${run}`)
  const south = await establishment(`Verdulería K046 ${run}`)
  // En secuencia: K008 admite dos cálculos de scrypt simultáneos y responde 503 al saturarse.
  const first = await account('primera')
  const second = await account('segunda')
  const outsider = await account('otro-local')
  const holder = await account('titular', { width: 360, height: 800 })
  await db.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$3),($2,$3),($4,$5)',
    [first.userId, second.userId, north.id, outsider.userId, south.id])
  const title = `Pan amasado K046 ${run}`
  const created = await first.call('POST', `/establishments/${north.public_id}/lots`, {
    description: title, category: 'Panadería', quantity: 3, address: 'Calle de Ejemplo 123, Santiago', latitude: -33.45, longitude: -70.66,
    timeZone: 'America/Santiago', pickupStartsAt: new Date(Date.now() - hour).toISOString(), pickupEndsAt: new Date(Date.now() + 3 * hour).toISOString(),
  })
  assert.equal(created.status, 201)
  const lot = created.body.id
  assert.equal((await first.call('POST', `/lots/${lot}/publish`, { version: 1 })).status, 200)
  const reserved = await holder.call('POST', `/public/lots/${lot}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })
  assert.equal(reserved.status, 201)
  ok('preparación: dos operadoras del establecimiento, otro local y una reserva en un lote abierto')

  // Quien reservó reporta desde el detalle de su reserva, a 360 px.
  const reason = `El pan llegó con moho ${run}`
  const holderPage = watch(await holder.context.newPage())
  await holderPage.goto(`${baseUrl}/reservas/${reserved.body.id}`)
  await holderPage.getByRole('link', { name: 'Reportar un problema' }).click()
  await holderPage.waitForURL(new RegExp(`/lotes/${lot}/reportar$`))
  await holderPage.getByText(title).waitFor()
  // Vacío lo bloquea el navegador (campo obligatorio); solo espacios lo rechaza la página sin enviar.
  await holderPage.getByLabel('¿Qué problema encontraste?').fill('   ')
  await holderPage.getByRole('button', { name: 'Enviar reporte' }).click()
  await holderPage.getByRole('alert').filter({ hasText: 'Describe el problema antes de enviarlo.' }).waitFor()
  await holderPage.getByLabel('¿Qué problema encontraste?').fill(reason)
  await holderPage.getByRole('button', { name: 'Enviar reporte' }).click()
  await holderPage.getByRole('status').filter({ hasText: 'Reporte enviado' }).waitFor()
  assert.ok(await noOverflow(holderPage), 'el reporte cabe a 360 px')
  assert.equal((await holder.call('GET', `/reservations/${reserved.body.id}`)).body.status, 'confirmed', 'reportar no cancela')
  await holderPage.goto(`${baseUrl}/operador/incidencias`)
  await holderPage.getByText('Tu cuenta todavía no está habilitada para operar un establecimiento.').waitFor()
  ok('quien reservó reporta desde su reserva a 360 px; el reporte no cancela y no accede a la gestión')

  // La primera operadora ve el reporte en su panel y lo publica sin cerrar el lote.
  const page = watch(await first.context.newPage())
  await page.goto(`${baseUrl}/operador/panel`)
  const review = page.getByRole('region', { name: 'Incidencias por revisar' })
  await review.getByText(reason).waitFor()
  await review.getByRole('link', { name: title }).click()
  await page.waitForURL(new RegExp(`/operador/lotes/${lot}/incidencias#incidencia-`))
  const card = page.locator('article.incident').filter({ hasText: reason })
  await card.getByText('Por revisar').waitFor()
  await card.getByText('Aún no se publica: nadie ha recibido avisos.').waitFor()
  assert.equal(await card.getByLabel('Motivo').inputValue(), reason, 'el motivo parte del reporte')
  await card.getByLabel('Instrucciones').fill('No consumir y traer el pack al local para reponerlo')
  await card.getByRole('button', { name: 'Publicar incidencia' }).click()
  await page.getByRole('status').filter({ hasText: 'Versión 1 publicada. Los avisos se generan en segundo plano.' }).waitFor()
  await card.getByText(`Publicó ${first.email}`).waitFor()
  await card.getByText('Avisos a 3 personas:').waitFor()
  assert.equal((await holder.call('GET', `/reservations/${reserved.body.id}`)).body.status, 'confirmed', 'publicar sin cierre no cancela')
  ok('el reporte llega a «Mi establecimiento»; publicar exige instrucciones, fija responsable y no cierra el lote')

  // El worker genera los avisos y la lectura de quien reservó se refleja en los conteos.
  const versionOne = card.locator('.incident-version').filter({ hasText: 'Versión 1' })
  const notices = async () => (await versionOne.locator('.incident-notices dd').allInnerTexts()).join('/')
  for (let attempt = 0; attempt < 20 && await notices() !== '0/3/0'; attempt++) {
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: 'Actualizar' }).click()
  }
  assert.equal(await notices(), '0/3/0', 'pendientes/generados/leídos tras el worker')
  const inbox = await holder.call('GET', '/notifications')
  const notice = inbox.body.items.find((item) => item.kind === 'incident_version')
  assert.equal((await holder.call('POST', `/notifications/${notice.id}/read`, {})).status, 200)
  await refillUserQuota(page)
  await page.getByRole('button', { name: 'Actualizar' }).click()
  await versionOne.locator('.incident-notices').filter({ hasText: 'Leídos1' }).waitFor()
  assert.equal(await notices(), '0/2/1')
  ok('avisos pendientes, generados y leídos por versión, sin identificar destinatarios')

  // La segunda operadora llega desde la lista general, actualiza cerrando el lote y resuelve.
  const other = watch(await second.context.newPage())
  await other.goto(`${baseUrl}/operador/incidencias`)
  await other.getByRole('link', { name: 'Publicadas' }).click()
  await other.waitForURL(/estado=publicadas/)
  const summary = other.locator('article.incident-summary').filter({ hasText: reason })
  await summary.getByText(`publicada por ${first.email}`).waitFor()
  await summary.getByRole('link', { name: 'Ver y gestionar' }).click()
  const secondCard = other.locator('article.incident').filter({ hasText: reason })
  await secondCard.getByLabel('Acción').selectOption('update')
  await secondCard.getByLabel('Instrucciones').fill('Se cerró el lote: acércate al local para reponer tu pack')
  await secondCard.getByRole('checkbox', { name: /Cerrar el lote con esta versión/ }).check()
  await secondCard.getByRole('button', { name: 'Publicar actualización' }).click()
  await secondCard.getByRole('alert').filter({ hasText: '¿Confirmas publicar y cerrar el lote?' }).waitFor()
  await secondCard.getByRole('button', { name: 'Confirmar y cerrar el lote' }).click()
  await other.getByRole('status').filter({ hasText: 'Versión 2 publicada y lote cerrado.' }).waitFor()
  await other.getByText('El lote está cerrado: las nuevas versiones avisan, pero no cambian reservas ni códigos.').waitFor()
  await secondCard.getByText('Con esta versión se decidió cerrar el lote.').waitFor()
  assert.equal((await holder.call('GET', `/reservations/${reserved.body.id}`)).body.status, 'cancelled', 'el cierre explícito cancela')
  await secondCard.getByLabel('Acción').selectOption('resolve')
  await secondCard.getByLabel('Motivo').fill('Se repusieron los packs afectados')
  await secondCard.getByRole('button', { name: 'Resolver incidencia' }).click()
  await other.getByRole('status').filter({ hasText: 'Versión 3 publicada.' }).waitFor()
  await secondCard.getByText('La incidencia está resuelta: no admite nuevas versiones.').waitFor()
  const authors = await secondCard.locator('.incident-version__meta strong').allInnerTexts()
  assert.deepEqual(authors, [second.email, second.email, first.email], 'cada versión conserva su responsable')
  ok('la lista general filtra por estado; cerrar exige confirmación explícita; resolver conserva responsable, motivo y fecha')

  // Otro establecimiento no ve ni gestiona estas incidencias.
  const outsiderPage = watch(await outsider.context.newPage())
  await outsiderPage.goto(`${baseUrl}/operador/incidencias`)
  await outsiderPage.getByText('No hay incidencias').waitFor()
  await outsiderPage.goto(`${baseUrl}/operador/lotes/${lot}/incidencias`)
  await outsiderPage.getByRole('alert').filter({ hasText: 'Tu cuenta no opera el establecimiento de este lote.' }).waitFor()
  assert.ok(!(await outsiderPage.locator('main').innerText()).includes(reason), 'sin datos del lote ajeno')
  ok('otro establecimiento no lista ni abre las incidencias ajenas')

  // A 360 px la gestión del lote no desborda.
  await refillUserQuota(page)
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto(`${baseUrl}/operador/lotes/${lot}/incidencias`)
  await page.locator('article.incident').filter({ hasText: reason }).getByText('Resuelta').first().waitFor()
  assert.ok(await noOverflow(page), 'la gestión cabe a 360 px')
  assert.deepEqual(pageErrors, [], 'sin errores de página')
  assert.deepEqual(rateLimited, [], 'sin 429')
  ok('360 px sin desplazamiento horizontal, sin errores de página ni 429')
} finally {
  await Promise.all(contexts.map((context) => context.close()))
  await browser.close()
  await db.end()
}
