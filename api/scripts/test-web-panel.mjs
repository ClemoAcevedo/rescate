import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { chromium } from './support/browser.mjs'

// K035: panel del establecimiento contra Vite HTTPS → proxy → API → PostgreSQL. Requiere
// servicios iniciados; DATABASE_URL habilita memberships ficticias y cierra un lote sin registrarlo.
const baseUrl = (process.env.WEB_URL ?? 'https://localhost:5174').replace(/\/$/, '')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL debe apuntar a la base de prueba usada por la API')
const password = 'K035-panel-password-segura'
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
/** Registra errores y 429 de cada pestaña, no solo de la primera. */
function watch(page) {
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('response', (response) => { if (response.status() === 429) rateLimited.push(new URL(response.url()).pathname) })
  return page
}

/** Cuenta propia (cuota de límite propia); su contexto comparte cookies entre API y navegador. */
async function account(label, viewport = { width: 1366, height: 768 }) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: 'America/Santiago', viewport })
  contexts.push(context)
  const email = `k035-${label}-${run}@example.com`
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

async function publishLot(operator, establishment, description, quantity) {
  const created = await operator.call('POST', `/establishments/${establishment}/lots`, {
    description, category: 'Panadería', quantity, address: 'Calle de Ejemplo 123, Santiago', latitude: -33.45, longitude: -70.66,
    timeZone: 'America/Santiago', pickupStartsAt: new Date(Date.now() - hour).toISOString(), pickupEndsAt: new Date(Date.now() + 3 * hour).toISOString(),
  })
  assert.equal(created.status, 201)
  assert.equal((await operator.call('POST', `/lots/${created.body.id}/publish`, { version: 1 })).status, 200)
  return created.body.id
}

async function reserve(rescuer, lotId, quantity) {
  const reserved = await rescuer.call('POST', `/public/lots/${lotId}/reservations`, { quantity, idempotencyKey: randomUUID() })
  assert.equal(reserved.status, 201)
  const detail = await rescuer.call('GET', `/reservations/${reserved.body.id}`)
  return { id: reserved.body.id, code: detail.body.pickupCode }
}

async function join(rescuer, lotId, quantity) {
  const joined = await rescuer.call('POST', `/public/lots/${lotId}/waitlist`, { quantity, idempotencyKey: randomUUID() })
  assert.equal(joined.status, 201)
  return joined.body
}

/** Texto visible sin códigos de retiro emitidos durante la prueba. */
async function assertNoCodes(page, codes) {
  const text = await page.locator('main').innerText()
  for (const code of codes) assert.ok(!text.includes(code), 'el panel no muestra códigos de retiro')
}

try {
  const establishment = async (name) => (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ($1,'Dirección ficticia',-33.45,-70.66,'America/Santiago') RETURNING id,public_id`, [name])).rows[0]
  const north = await establishment(`Panadería K035 ${run}`)
  const south = await establishment(`Verdulería K035 ${run}`)
  // Una cuenta publica y otra mira el panel: cada una con su propia cuota por usuario.
  const publisher = await account('publicador')
  const operator = await account('operador')
  const outsider = await account('otro-local')
  await db.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$3),($2,$3),($4,$5)',
    [publisher.userId, operator.userId, north.id, outsider.userId, south.id])
  // En secuencia: K008 admite dos cálculos de scrypt simultáneos y responde 503 al saturarse.
  const rescuers = []
  for (const label of ['ana', 'beto', 'carla', 'dani']) rescuers.push(await account(label))
  const [ana, beto, carla, dani] = rescuers

  const openTitle = `Pan amasado K035 ${run}`
  const closedTitle = `Queques K035 ${run}`
  const openLot = await publishLot(publisher, north.public_id, openTitle, 3)
  const closedLot = await publishLot(publisher, north.public_id, closedTitle, 4)
  const southLot = await publishLot(outsider, south.public_id, `Verduras K035 ${run}`, 5)
  const codes = []
  codes.push((await reserve(ana, openLot, 2)).code)
  const offer = await join(beto, openLot, 2)
  assert.deepEqual([offer.status, offer.offeredQuantity], ['offered', 1])
  assert.equal((await join(carla, openLot, 1)).status, 'waiting')
  const delivered = await reserve(dani, closedLot, 2)
  codes.push(delivered.code)
  assert.equal((await publisher.call('POST', `/lots/${closedLot}/pickups`,
    { reservationId: delivered.id, code: delivered.code, idempotencyKey: randomUUID() })).status, 201)
  codes.push((await reserve(ana, southLot, 3)).code)
  // Cierra hoy la ventana del segundo lote sin registrarlo: el panel lo cuenta igual en el período.
  await db.query(`UPDATE lots SET pickup_starts_at = now() - interval '2 hours', pickup_ends_at = now() - interval '1 minute'
    WHERE public_id = $1`, [closedLot])
  ok('preparación: lote abierto con reserva, oferta parcial y espera; lote cerrado hoy con un retiro; otro establecimiento')

  const page = watch(await operator.context.newPage())
  await page.goto(`${baseUrl}/operador/lotes`)
  await page.getByRole('link', { name: 'Mi establecimiento' }).click()
  await page.waitForURL(/\/operador\/panel$/)
  await page.getByRole('heading', { level: 1, name: 'Mi establecimiento' }).waitFor()
  const now = page.getByRole('region', { name: 'Ahora' })
  const stat = (label) => now.locator('.panel-stat').filter({ hasText: label }).locator('.panel-stat__value')
  await stat('Lotes abiertos').filter({ hasText: '1' }).waitFor()
  assert.deepEqual(await Promise.all(['Lotes abiertos', 'Reservas por retirar', 'Ofertas por aceptar', 'Personas en espera']
    .map(async label => (await stat(label).innerText()).trim())), ['1', '1', '1', '1'])
  assert.equal((await now.locator('.panel-stat').filter({ hasText: 'Ofertas por aceptar' }).locator('.panel-stat__detail').innerText()).trim(), '1 pack retenido')
  const card = now.getByRole('article').filter({ hasText: openTitle })
  const legend = await card.getByRole('list', { name: 'Estado de los 3 packs' }).innerText()
  for (const [label, value] of [['Libres', 0], ['Ofrecidos', 1], ['Reservados', 2], ['Retirados', 0], ['No asignables', 0]]) {
    assert.match(legend, new RegExp(`${label}\\s+${value}\\b`))
  }
  assert.equal(await now.getByText(closedTitle).count(), 0, 'el lote cerrado no figura entre los abiertos')
  assert.match(await card.innerText(), /1 persona en espera · 1 oferta por aceptar/)
  ok('ahora: cifras del establecimiento y barra de inventario F/O/R/E/X con sus valores como texto')

  const period = page.getByRole('region', { name: 'Resultados del período' })
  assert.match(await period.innerText(), /Lotes cerrados entre el .+ y el .+: 1\./)
  const rate = (title) => period.locator('.panel-rate').filter({ has: page.getByRole('heading', { name: title }) })
  assert.match(await rate('Packs retirados').innerText(), /50\s?%[\s\S]*2 retirados de 4 publicados/)
  assert.match(await rate('Reservas vencidas').innerText(), /0\s?%[\s\S]*0 vencidas de 1 confirmadas/)
  assert.match(await period.innerText(), /No incluye 1 lote abierto ni 0 borradores/)
  ok('período: lote cerrado hoy sin registrar, tasas con numerador y denominador y exclusiones visibles')

  const commitments = page.getByRole('region', { name: 'Compromisos' })
  await commitments.getByText('Por retirar').waitFor()
  const active = await commitments.innerText()
  for (const label of ['Por retirar', 'Oferta por aceptar', 'En espera']) assert.ok(active.includes(label), label)
  assert.ok(!active.includes('Retirada'), 'la reserva retirada no es vigente')
  await commitments.getByRole('link', { name: 'Terminados' }).click()
  await commitments.getByText('Retirada').waitFor()
  const history = page.getByRole('region', { name: 'Historial' })
  await history.getByText('Se acreditó el retiro de 2 packs').waitFor()
  await assertNoCodes(page, codes)
  assert.ok(!(await page.locator('main').innerText()).includes(`Verduras K035 ${run}`), 'sin lotes de otro establecimiento')
  ok('compromisos vigentes y terminados, historial con el retiro acreditado, sin códigos ni lotes ajenos')

  // Filtrar por lote desde su tarjeta: compromisos e historial muestran solo ese lote.
  await commitments.getByRole('link', { name: 'Vigentes' }).click()
  await card.getByRole('button', { name: 'Ver compromisos' }).click()
  await page.waitForURL(new RegExp(`lote=${openLot}`))
  // El retiro pertenece al otro lote: desaparece cuando llega el historial filtrado.
  await history.getByText('Se acreditó el retiro de 2 packs').waitFor({ state: 'detached' })
  await history.getByText('Una persona entró a la espera por 1 pack').waitFor()
  assert.equal(await commitments.getByLabel('Lote').inputValue(), openLot)
  ok('filtro por lote: la URL conserva el lote y el historial omite los hechos de otros lotes')

  // Período: una fecha invertida se corrige en el formulario sin consultar; un día sin cierres no tiene tasa.
  let panelRequests = 0
  page.on('request', (request) => { if (/\/panel(\?|$)/.test(new URL(request.url()).pathname + new URL(request.url()).search)) panelRequests++ })
  await period.getByLabel('Desde').fill('2026-01-10')
  await period.getByLabel('Hasta').fill('2026-01-09')
  await period.getByRole('button', { name: 'Ver período' }).click()
  await period.getByText('La fecha inicial no puede ser posterior a la final.').waitFor()
  assert.equal(panelRequests, 0)
  await period.getByLabel('Hasta').fill('2026-01-10')
  await period.getByRole('button', { name: 'Ver período' }).click()
  await page.waitForURL(/desde=2026-01-10&hasta=2026-01-10/)
  await period.getByText('Ningún lote cerró en el período.').waitFor()
  assert.match(await period.innerText(), /Lotes cerrados entre el .+ y el .+: 0\./)
  ok('período elegido: validación local de fechas y tasa sin datos cuando no hay denominador')

  // Más de 366 días: el formulario lo frena; si llega por la URL, el 422 deja el formulario para corregirlo.
  panelRequests = 0
  await period.getByLabel('Desde').fill('2025-01-09')
  await period.getByRole('button', { name: 'Ver período' }).click()
  await period.getByText('El período puede abarcar como máximo 366 días.').waitFor()
  assert.equal(panelRequests, 0)
  await page.goto(`${baseUrl}/operador/panel?desde=2025-01-09&hasta=2026-01-10`)
  await page.getByRole('alert').filter({ hasText: 'Reintentar' }).waitFor()
  assert.equal(await period.getByLabel('Desde').inputValue(), '2025-01-09')
  await period.getByLabel('Desde').fill('2025-01-10')
  await period.getByRole('button', { name: 'Ver período' }).click()
  await page.waitForURL(/desde=2025-01-10&hasta=2026-01-10/)
  await period.getByText(/Lotes cerrados entre el .+: 0\./).waitFor()
  ok('período de más de 366 días: validación local y formulario visible tras el 422 de la URL')

  // Otro operador ve solo su establecimiento; una cuenta sin membership no ve el panel.
  const outsiderPage = watch(await outsider.context.newPage())
  await outsiderPage.goto(`${baseUrl}/operador/panel`)
  await outsiderPage.getByRole('region', { name: 'Ahora' }).getByText(`Verduras K035 ${run}`).waitFor()
  const outsiderText = await outsiderPage.locator('main').innerText()
  assert.ok(!outsiderText.includes(openTitle) && !outsiderText.includes(closedTitle), 'sin datos del otro establecimiento')
  const rescuerPage = watch(await ana.context.newPage())
  await rescuerPage.goto(`${baseUrl}/operador/panel`)
  await rescuerPage.getByText('Tu cuenta todavía no está habilitada para operar un establecimiento.').waitFor()
  assert.equal(await rescuerPage.getByRole('link', { name: 'Mi establecimiento' }).count(), 0)
  ok('acceso: cada operador ve su establecimiento; una cuenta sin membership ni siquiera ve el enlace')

  // 360 px: sin desplazamiento horizontal y con las cifras legibles.
  await refillUserQuota(page)
  const narrow = watch(await operator.context.newPage())
  await narrow.setViewportSize({ width: 360, height: 780 })
  await narrow.goto(`${baseUrl}/operador/panel`)
  await narrow.getByRole('region', { name: 'Ahora' }).getByText(openTitle).waitFor()
  await narrow.getByRole('region', { name: 'Historial' }).getByText('Se acreditó el retiro de 2 packs').waitFor()
  await narrow.getByRole('region', { name: 'Compromisos' }).getByText('Por retirar').waitFor()
  const overflow = await narrow.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  assert.ok(overflow <= 0, `desborde horizontal de ${overflow}px a 360 px`)
  ok('360 px: el panel se apila sin desplazamiento horizontal')

  assert.deepEqual(pageErrors, [])
  assert.deepEqual(rateLimited, [])
  ok('sin errores de página ni respuestas 429')
} finally {
  await Promise.all(contexts.map((context) => context.close()))
  await browser.close()
  await db.end()
}
