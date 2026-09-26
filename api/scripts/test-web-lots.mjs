import assert from 'node:assert/strict'
import pg from 'pg'
import { chromium } from 'playwright'

// K011: recorrido real web → proxy → API → PostgreSQL. Requiere Vite HTTPS, API y una base
// de prueba ya migrada; DATABASE_URL solo se usa para habilitar la membresía ficticia.
const baseUrl = (process.env.WEB_URL ?? 'https://localhost:5174').replace(/\/$/, '')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL debe apuntar a la base de prueba usada por la API')
const email = `k011-${Date.now()}@example.com`
const password = 'K011-operator-lot-test-password'
const year = new Date().getFullYear()
const future = { start: `${year + 1}-01-15T18:00`, end: `${year + 1}-01-15T21:00` }
const past = { start: `${year - 1}-01-15T18:00`, end: `${year - 1}-01-15T21:00` }

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: 'America/Santiago', geolocation: { latitude: -33.4372091, longitude: -70.6506452, accuracy: 25 }, viewport: { width: 1366, height: 768 } })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))
const commands = []
page.on('request', (request) => {
  const { pathname } = new URL(request.url())
  if (request.method() !== 'GET' && pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/')) {
    commands.push({ method: request.method(), path: pathname, body: request.postDataJSON() })
  }
})
const ok = (message) => console.log(`✓ ${message}`)
const rateLimited = []
page.on('response', (response) => { if (response.status() === 429) rateLimited.push(new URL(response.url()).pathname) })

async function waitForApiResponse(path, method, action) {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (typeof path === 'string' ? url.pathname === path : path.test(url.pathname)) && response.request().method() === method
  })
  await action()
  return responsePromise
}

async function fillLot(values) {
  for (const [name, value] of Object.entries(values)) {
    const control = page.locator(`[name="${name}"]`)
    if (name === 'timeZone' || name === 'establishmentId') await control.selectOption(value)
    else await control.fill(value)
  }
}

async function assertNoHorizontalScroll(viewport) {
  await page.setViewportSize(viewport)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `scroll horizontal en ${viewport.width}px`)
  await page.screenshot({ path: `/tmp/rescate-k011-${viewport.width}x${viewport.height}.png`, fullPage: true })
}

async function apiCommand(method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const { csrfToken } = await (await fetch('/api/auth/session')).json()
    const response = await fetch(`/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }, { method, path, body })
}

async function signIn(accountEmail, from) {
  const registered = await page.evaluate(async ({ email, password }) => {
    const { csrfToken } = await (await fetch('/api/auth/session')).json()
    const response = await fetch('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ email, password }),
    })
    return response.status
  }, { email: accountEmail, password })
  assert.equal(registered, 201)
  await page.goto(`${baseUrl}/login?from=${encodeURIComponent(from)}`)
  await page.locator('input[name="email"]').fill(accountEmail)
  await page.locator('input[name="password"]').fill(password)
  await page.getByRole('button', { name: 'Iniciar sesión' }).click()
}

async function grantMembership(accountEmail, establishmentId) {
  const user = (await db.query('SELECT id FROM users WHERE email=$1', [accountEmail])).rows[0]
  await db.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)', [user.id, establishmentId])
}

const validLot = {
  description: 'Pack de cuatro panes surtidos.',
  category: 'Panadería',
  quantity: '12',
  address: 'Calle de Ejemplo 123, Santiago',
  latitude: '-33.45',
  longitude: '-70.66',
  pickupStartsAt: future.start,
  pickupEndsAt: future.end,
}

try {
  await page.goto(`${baseUrl}/operador/lotes/nuevo`)
  await page.getByRole('link', { name: 'Iniciar sesión' }).last().waitFor()
  assert.equal(await page.locator('form.lot-form').count(), 0)
  ok('visitante: sin formulario y con enlace a iniciar sesión')

  await signIn(email, '/operador/lotes/nuevo')
  await page.waitForURL(`${baseUrl}/operador/lotes/nuevo`)
  await page.getByText('todavía no está habilitada').waitFor()
  assert.equal(await page.getByRole('link', { name: 'Publicar lote' }).count(), 0)
  ok('sesión sin membresía: vuelve al formulario tras login y explica que no está habilitada')

  const estate = (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('Panadería ficticia K011','Dirección ficticia',-33.45,-70.66,'America/Santiago') RETURNING id,public_id`)).rows[0]
  await grantMembership(email, estate.id)
  await page.reload()
  await page.getByRole('link', { name: 'Publicar lote' }).waitFor()
  await page.locator('form.lot-form').waitFor()
  assert.equal(await page.locator('[name="establishmentId"]').inputValue(), estate.public_id)
  assert.equal(await page.locator('[name="timeZone"]').inputValue(), 'America/Santiago')
  await page.getByText('Pendiente de validación').waitFor()
  assert.equal(await page.locator('input[type="file"]').count(), 0)
  ok('con membresía: enlace, establecimiento único preseleccionado, zona America/Santiago por defecto y fotos solo como aviso')

  const locateButton = page.getByRole('button', { name: 'Usar mi ubicación actual' })
  await context.clearPermissions()
  await locateButton.click()
  await page.getByText('No se concedió permiso para usar tu ubicación').waitFor()
  assert.equal(await page.locator('[name="latitude"]').inputValue(), '')
  await context.grantPermissions(['geolocation'], { origin: baseUrl })
  await locateButton.click()
  await page.getByText('Coordenadas completadas con tu ubicación actual').waitFor()
  assert.equal(await page.locator('[name="latitude"]').inputValue(), '-33.437209')
  assert.equal(await page.locator('[name="longitude"]').inputValue(), '-70.650645')
  assert.equal(commands.length, 0)
  ok('ubicación actual: permiso denegado explicado; concedido completa latitud/longitud sin llamar a la API')

  const quantityInput = page.locator('[name="quantity"]')
  await quantityInput.pressSequentially('1e2a-')
  assert.equal(await quantityInput.inputValue(), '12')
  await quantityInput.fill('1.5')
  assert.equal(await quantityInput.inputValue(), '12')
  const latitudeInput = page.locator('[name="latitude"]')
  await latitudeInput.fill('-33,451')
  assert.equal(await latitudeInput.inputValue(), '-33.451')
  await latitudeInput.fill('-33.4a5')
  assert.equal(await latitudeInput.inputValue(), '-33.451')
  await quantityInput.fill('')
  ok('campos numéricos: ignoran letras y valores no numéricos al escribir o pegar; aceptan coma decimal')

  await assertNoHorizontalScroll({ width: 360, height: 800 })
  await assertNoHorizontalScroll({ width: 1366, height: 768 })
  ok('formulario sin scroll horizontal en 360×800 y 1366×768')

  await page.getByRole('button', { name: 'Guardar borrador' }).click()
  await page.getByRole('alert').filter({ hasText: 'Revisa los campos indicados' }).waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'description')
  await fillLot({ ...validLot, pickupEndsAt: future.start })
  await page.getByRole('button', { name: 'Guardar borrador' }).click()
  await page.getByText('El cierre del retiro debe ser posterior al inicio.').waitFor()
  assert.equal(commands.length, 0)
  ok('validación local: errores por campo, foco en el primero y ningún comando enviado')

  await fillLot({ pickupEndsAt: future.end })
  const created = await waitForApiResponse(/\/api\/establishments\/[^/]+\/lots$/, 'POST', () => page.getByRole('button', { name: 'Guardar borrador' }).click())
  assert.equal(created.status(), 201)
  const createdLot = await created.json()
  assert.deepEqual(commands.at(-1).body, {
    description: validLot.description, category: validLot.category, quantity: 12, conditions: null, address: validLot.address,
    latitude: -33.45, longitude: -70.66, timeZone: 'America/Santiago',
    pickupStartsAt: `${future.start}:00-03:00`, pickupEndsAt: `${future.end}:00-03:00`,
  })
  await page.waitForURL(`${baseUrl}/operador/lotes/${createdLot.id}`)
  await page.getByText('Borrador guardado. Revísalo').waitFor()
  await page.getByText('Borrador · versión 1').waitFor()
  await page.reload()
  await page.getByText('Borrador · versión 1').waitFor()
  assert.equal(await page.locator('[name="description"]').inputValue(), validLot.description)
  assert.equal(await page.locator('[name="pickupStartsAt"]').inputValue(), future.start)
  ok('crear: POST 201 con cuerpo del contrato (offset explícito), navega al lote y persiste tras recargar')

  const publishButton = page.getByRole('button', { name: 'Publicar lote' })
  assert.equal(await page.getByRole('button', { name: 'Guardar borrador' }).isDisabled(), true)
  await page.locator('[name="conditions"]').fill('Traer una bolsa.')
  assert.equal(await publishButton.isDisabled(), true)
  await page.getByText('Guarda el borrador antes de publicar').waitFor()
  const patched = await waitForApiResponse(`/api/lots/${createdLot.id}`, 'PATCH', () => page.getByRole('button', { name: 'Guardar borrador' }).click())
  assert.equal(patched.status(), 200)
  assert.deepEqual(commands.at(-1).body, { version: 1, conditions: 'Traer una bolsa.' })
  await page.getByText('Borrador · versión 2').waitFor()
  assert.equal(await publishButton.isDisabled(), false)
  ok('editar: PATCH solo con versión y campo modificado; publicar exige guardar antes')

  const external = await apiCommand('PATCH', `/lots/${createdLot.id}`, { version: 2, quantity: 10 })
  assert.equal(external.status, 200)
  await page.locator('[name="category"]').fill('Panadería y pastelería')
  const conflict = await waitForApiResponse(`/api/lots/${createdLot.id}`, 'PATCH', () => page.getByRole('button', { name: 'Guardar borrador' }).click())
  assert.equal(conflict.status(), 409)
  await page.getByRole('alert').filter({ hasText: 'El lote cambió' }).waitFor()
  assert.equal(await page.locator('[name="category"]').inputValue(), 'Panadería y pastelería')
  await page.getByRole('button', { name: 'Recargar lote' }).click()
  await page.getByText('Borrador · versión 3').waitFor()
  assert.equal(await page.locator('[name="quantity"]').inputValue(), '10')
  assert.equal(await page.locator('[name="category"]').inputValue(), 'Panadería')
  ok('conflicto: 409 conserva lo escrito hasta que la persona recarga la versión actual')

  await publishButton.click()
  const confirm = page.getByRole('button', { name: 'Confirmar publicación' })
  await confirm.waitFor()
  const before = commands.length
  const published = await waitForApiResponse(`/api/lots/${createdLot.id}/publish`, 'POST', () => confirm.dblclick())
  assert.equal(published.status(), 200)
  await page.getByRole('heading', { name: 'Lote publicado' }).waitFor()
  assert.equal(commands.length - before, 1)
  assert.deepEqual(commands.at(-1).body, { version: 3 })
  assert.equal(await page.locator('form.lot-form').count(), 0)
  await page.reload()
  await page.getByRole('heading', { name: 'Lote publicado' }).waitFor()
  await page.getByText('Traer una bolsa.').waitFor()
  ok('publicar: confirmación explícita, un solo POST ante doble clic y vista de solo lectura persistente')

  const republish = await apiCommand('POST', `/lots/${createdLot.id}/publish`, { version: 4 })
  assert.equal(republish.status, 409)
  ok('lote publicado: la API rechaza republicar (409), la UI no ofrece edición')

  // K008 limita por usuario (ráfaga 20, 2/s). Los casos restantes usan otra cuenta con su propia cuota.
  await page.getByRole('button', { name: 'Cerrar sesión' }).click()
  await page.getByRole('link', { name: 'Iniciar sesión' }).first().waitFor()
  const secondEmail = `k011-second-${Date.now()}@example.com`
  await signIn(secondEmail, '/operador/lotes/nuevo')
  await page.waitForURL(`${baseUrl}/operador/lotes/nuevo`)
  await grantMembership(secondEmail, estate.id)
  const suffix = Date.now()
  const others = []
  for (const name of [`Café Ñuñoa ${suffix}`, `Carnicería Centro ${suffix}`]) {
    const other = (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
      VALUES ($1,'Dirección ficticia',-33.45,-70.66,'America/Santiago') RETURNING id,public_id`, [name])).rows[0]
    await grantMembership(secondEmail, other.id)
    others.push({ ...other, name })
  }
  await page.reload()
  await page.locator('form.lot-form').waitFor()
  const establishmentInput = page.getByRole('combobox', { name: /Establecimiento/ })
  const establishmentValue = page.locator('[name="establishmentId"]')
  assert.equal(await establishmentValue.inputValue(), '')
  await fillLot({ ...validLot, pickupStartsAt: past.start, pickupEndsAt: past.end })
  await page.getByRole('button', { name: 'Guardar borrador' }).click()
  await page.getByText('Selecciona el establecimiento del lote.').waitFor()
  assert.equal(await establishmentInput.evaluate((element) => document.activeElement === element), true)
  await establishmentInput.fill(`cafe nunoa ${suffix}`)
  assert.deepEqual(await page.getByRole('listbox').getByRole('option').allTextContents(), [others[0].name])
  await establishmentInput.press('Enter')
  assert.equal(await establishmentValue.inputValue(), others[0].public_id)
  assert.equal(await establishmentInput.inputValue(), others[0].name)
  await establishmentInput.fill('zzz-sin-resultado')
  await page.getByText('Sin coincidencias.').waitFor()
  assert.equal(await establishmentValue.inputValue(), '')
  await establishmentInput.fill('panaderia ficticia k011')
  await page.getByRole('listbox').getByRole('option', { name: 'Panadería ficticia K011' }).click()
  assert.equal(await establishmentValue.inputValue(), estate.public_id)
  ok('establecimiento: filtro por texto sin tildes, teclado, clic, sin coincidencias y selección obligatoria')

  const timeZoneInput = page.getByRole('combobox', { name: /Zona horaria/ })
  await timeZoneInput.fill('lima')
  assert.deepEqual(await page.getByRole('listbox').getByRole('option').allTextContents(), ['America/Lima'])
  await timeZoneInput.press('Enter')
  assert.equal(await page.locator('[name="timeZone"]').inputValue(), 'America/Lima')
  await timeZoneInput.fill('santiago')
  await page.getByRole('listbox').getByRole('option', { name: 'America/Santiago' }).click()
  assert.equal(await page.locator('[name="timeZone"]').inputValue(), 'America/Santiago')
  ok('zona horaria: filtro por texto y selección con teclado y clic')
  const pastCreated = await waitForApiResponse(/\/api\/establishments\/[^/]+\/lots$/, 'POST', () => page.getByRole('button', { name: 'Guardar borrador' }).click())
  assert.equal(pastCreated.status(), 201)
  await page.getByText('Borrador · versión 1').waitFor()
  await page.getByRole('button', { name: 'Publicar lote' }).click()
  const rejected = await waitForApiResponse(/\/api\/lots\/[^/]+\/publish$/, 'POST', () => page.getByRole('button', { name: 'Confirmar publicación' }).click())
  assert.equal(rejected.status(), 422)
  const rejectedBody = await rejected.json()
  assert.equal(rejectedBody.error.code, 'VALIDATION_ERROR')
  await page.getByRole('alert').filter({ hasText: 'Revisa los campos indicados' }).waitFor()
  const invalidFields = await page.locator('[aria-invalid="true"]').evaluateAll((elements) => elements.map((element) => element.getAttribute('name')))
  assert.deepEqual(invalidFields, rejectedBody.error.details.issues.map((issue) => issue.path.split('/')[1]))
  ok(`validación del servidor: 422 al publicar una ventana vencida se muestra en ${invalidFields.join(', ')}`)

  const missingId = '00000000-0000-4000-8000-000000000000'
  const missing = await waitForApiResponse(`/api/lots/${missingId}`, 'GET', () => page.goto(`${baseUrl}/operador/lotes/${missingId}`))
  assert.equal(missing.status(), 404)
  await page.getByRole('alert').filter({ hasText: 'El lote no existe' }).waitFor()
  ok('lote inexistente: 404 explicado sin formulario')

  assert.deepEqual(pageErrors, [])
  assert.deepEqual(rateLimited, [], 'la prueba no debe depender de respuestas 429')
  ok('ninguna respuesta 429 durante el recorrido')
  console.log('K011 web lots: real API, proxy, CSRF, draft, edit, conflict, publish and errors checks passed')
} catch (error) {
  if (rateLimited.length > 0) console.error('Respuestas 429 durante la prueba:', rateLimited)
  throw error
} finally {
  await browser.close()
  await db.end()
}
