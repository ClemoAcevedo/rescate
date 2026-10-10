import assert from 'node:assert/strict'
import pg from 'pg'
import sharp from 'sharp'
import { chromium } from 'playwright'

// K011/K017: recorrido real web → proxy → API → PostgreSQL (y worker de fotos para K017). Requiere Vite HTTPS, API y una base
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
    let body = null
    try { body = request.postDataJSON() } catch { body = null } // las fotos viajan como binario
    commands.push({ method: request.method(), path: pathname, body })
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

async function assertNoHorizontalScroll(viewport, name = 'k011') {
  await page.setViewportSize(viewport)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `scroll horizontal en ${viewport.width}px`)
  await page.screenshot({ path: `/tmp/rescate-${name}-${viewport.width}x${viewport.height}.png`, fullPage: true })
}

// Ráfaga completa del límite por usuario de K008: 20 solicitudes a 2/s.
const refillUserQuota = () => page.waitForTimeout(10_000)

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
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ email, password, privacyConsent: true }),
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
  await page.getByText('Guarda el borrador para agregar hasta tres fotos').waitFor()
  assert.equal(await page.locator('input[type="file"]').count(), 0)
  ok('con membresía: enlace, establecimiento único preseleccionado, zona America/Santiago por defecto y fotos tras guardar')

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

  // K008 limita por usuario (ráfaga 20, 2/s) y cuenta también las lecturas; desde K017 el editor
  // además consulta fotos. Esperar a que la ráfaga se recupere antes de los últimos pasos de esta cuenta.
  await refillUserQuota()
  const republish = await apiCommand('POST', `/lots/${createdLot.id}/publish`, { version: 4 })
  assert.equal(republish.status, 409)
  ok('lote publicado: la API rechaza republicar (409), la UI no ofrece edición')

  // Los casos restantes usan otra cuenta con su propia cuota.
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

  // K017: fotos con worker real. Tercera cuenta con su propia cuota de límite por usuario.
  await page.getByRole('button', { name: 'Cerrar sesión' }).click()
  await page.getByRole('link', { name: 'Iniciar sesión' }).first().waitFor()
  const photoEmail = `k017-photos-${Date.now()}@example.com`
  await signIn(photoEmail, '/operador/lotes/nuevo')
  await page.waitForURL(`${baseUrl}/operador/lotes/nuevo`)
  await grantMembership(photoEmail, estate.id)
  await page.reload()
  await page.locator('form.lot-form').waitFor()
  await page.getByText('Guarda el borrador para agregar hasta tres fotos').waitFor()
  assert.equal(await page.locator('input[name="photo"]').count(), 0)
  await fillLot({ ...validLot, conditions: 'Traer una bolsa reutilizable.' })
  const photoLotResponse = await waitForApiResponse(/\/api\/establishments\/[^/]+\/lots$/, 'POST', () => page.getByRole('button', { name: 'Guardar borrador' }).click())
  const photoLot = await photoLotResponse.json()
  await page.getByText('Borrador · versión 1').waitFor()
  await page.getByText('0 de 3').waitFor()
  ok('fotos: en un lote nuevo se pide guardar antes; el borrador muestra 0 de 3')

  const photoInput = page.locator('input[name="photo"]')
  const photoPath = `/api/lots/${photoLot.id}/photos`
  const commandsBeforePhotos = commands.length
  await photoInput.setInputFiles({ name: 'notas.txt', mimeType: 'text/plain', buffer: Buffer.from('no es una imagen') })
  await page.getByRole('alert').filter({ hasText: 'Usa una imagen JPEG, PNG o WebP.' }).waitFor()
  assert.equal(commands.length, commandsBeforePhotos)
  const fake = await waitForApiResponse(photoPath, 'POST', () => photoInput.setInputFiles({ name: 'foto.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('esto no es una imagen, aunque se llame foto.jpg') }))
  assert.equal(fake.status(), 422)
  await page.getByRole('alert').filter({ hasText: 'no es una imagen JPEG, PNG o WebP válida' }).waitFor()
  await page.getByText('0 de 3').waitFor()
  ok('fotos: tipo no permitido se avisa sin enviar; archivo falso con MIME de imagen → 422 sin agregar foto')

  const frames = await Promise.all(['#f00', '#00f'].map((color) => sharp({ create: { width: 40, height: 40, channels: 3, background: color } }).png().toBuffer()))
  const animated = await sharp(frames, { join: { animated: true } }).webp().toBuffer()
  const animatedUpload = await waitForApiResponse(photoPath, 'POST', () => photoInput.setInputFiles({ name: 'animada.webp', mimeType: 'image/webp', buffer: animated }))
  assert.equal(animatedUpload.status(), 202)
  assert.equal(commands.at(-1).body, null)
  await page.getByText('Foto recibida. Se está validando').waitFor()
  await page.getByText('Las imágenes animadas no están permitidas.').waitFor({ timeout: 20000 })
  await page.getByText('Hay fotos en carga, en validación o rechazadas').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Publicar lote' }).isDisabled(), true)
  ok('fotos: animada → 202, el worker la rechaza, la UI muestra el motivo y bloquea publicar (D-05)')

  const jpeg = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#3a7' } }).jpeg({ quality: 85 }).toBuffer()
  const validUpload = await waitForApiResponse(photoPath, 'POST', () => photoInput.setInputFiles({ name: 'pan.jpg', mimeType: 'image/jpeg', buffer: jpeg }))
  assert.equal(validUpload.status(), 202)
  const thumbnail = page.locator('.lot-photo-item img.lot-photo')
  await thumbnail.waitFor({ timeout: 20000 })
  await page.waitForFunction(() => {
    const image = document.querySelector('.lot-photo-item img.lot-photo')
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
  })
  assert.match(await thumbnail.getAttribute('src'), /^\/api\/lots\/[^/]+\/photos\/[^/]+\/thumbnail$/)
  await page.getByText('2 de 3').waitFor()
  await page.getByText('Foto recibida. Se está validando').waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('button', { name: 'Publicar lote' }).isDisabled(), true)
  await page.locator('.lot-photos').scrollIntoViewIfNeeded()
  await assertNoHorizontalScroll({ width: 360, height: 800 }, 'k017')
  await assertNoHorizontalScroll({ width: 1366, height: 768 }, 'k017')
  ok('fotos: JPEG válido → lista; la miniatura carga desde la API del borrador; sin scroll horizontal')

  const rejectedCard = page.locator('.lot-photo-item').filter({ hasText: 'Rechazada' })
  const removal = await waitForApiResponse(/\/api\/lots\/[^/]+\/photos\/[^/]+$/, 'DELETE', () => rejectedCard.getByRole('button', { name: /Quitar foto/ }).click())
  assert.equal(removal.status(), 204)
  await page.getByText('1 de 3').waitFor()
  await page.getByText('Hay fotos en carga, en validación o rechazadas').waitFor({ state: 'detached' })
  ok('fotos: quitar la rechazada vuelve a habilitar publicar')

  // Otra pestaña carga una foto que esta vista no conoce: la API decide con 422 (D-05).
  const outside = await page.evaluate(async ({ path, bytes }) => {
    const { csrfToken } = await (await fetch('/api/auth/session')).json()
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-CSRF-Token': csrfToken }, body: new Uint8Array(bytes) })
    return response.status
  }, { path: photoPath, bytes: [...jpeg] })
  assert.equal(outside, 202)
  await page.getByRole('button', { name: 'Publicar lote' }).click()
  const blocked = await waitForApiResponse(`/api/lots/${photoLot.id}/publish`, 'POST', () => page.getByRole('button', { name: 'Confirmar publicación' }).click())
  assert.equal(blocked.status(), 422)
  await page.getByRole('alert').filter({ hasText: 'Hay fotos en carga, en validación o rechazadas; espera o quítalas antes de publicar.' }).waitFor()
  await page.getByText('2 de 3').waitFor()
  ok('fotos: 422 por foto no lista muestra el mensaje de la API y actualiza la lista')

  await page.waitForFunction(() => document.querySelectorAll('.lot-photo-item img.lot-photo').length === 2, null, { timeout: 20000 })
  await page.getByRole('button', { name: 'Publicar lote' }).click()
  const photoPublish = await waitForApiResponse(`/api/lots/${photoLot.id}/publish`, 'POST', () => page.getByRole('button', { name: 'Confirmar publicación' }).click())
  assert.equal(photoPublish.status(), 200)
  await page.getByRole('heading', { name: 'Lote publicado' }).waitFor()
  await page.getByText('Las fotos quedaron fijas al publicar.').waitFor()
  assert.equal(await page.locator('.lot-photo-item').count(), 2)
  assert.equal(await page.getByRole('button', { name: /Quitar foto|Agregar foto/ }).count(), 0)
  ok('fotos: publicado con fotos válidas, en solo lectura y sin acciones de carga')

  await page.goto(`${baseUrl}/lotes/${photoLot.id}`)
  await page.waitForFunction(() => [...document.querySelectorAll('img.lot-photo')].some((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))
  await page.route(/\/api\/lots\/[^/]+\/photos\/[^/]+\/(display|thumbnail)$/, (route) => route.fulfill({ status: 503, body: '' }))
  await page.reload()
  await page.getByRole('img', { name: 'Fotografía no disponible' }).first().waitFor()
  await page.getByRole('heading', { name: 'Condiciones del lote' }).waitFor()
  await page.getByText('Traer una bolsa reutilizable.').waitFor()
  await page.unroute(/\/api\/lots\/[^/]+\/photos\/[^/]+\/(display|thumbnail)$/)
  ok('fotos: el detalle público muestra la foto; si la imagen falla, hay reemplazo y las condiciones siguen visibles')

  await page.reload()
  const thumbs = page.getByRole('button', { name: /^Ver foto \d$/ })
  await thumbs.nth(1).waitFor()
  assert.equal(await thumbs.count(), 2)
  assert.equal(await thumbs.nth(0).getAttribute('aria-pressed'), 'true')
  await thumbs.nth(1).click()
  assert.equal(await thumbs.nth(1).getAttribute('aria-pressed'), 'true')
  await page.getByRole('img', { name: /^Foto 2 de 2/ }).waitFor()
  ok('galería: el detalle público muestra las dos fotos listas y permite elegir cada una')

  // #96: el operador recupera sus lotes sin conocer su ID.
  await refillUserQuota()
  await page.goto(`${baseUrl}/operador/lotes`)
  const photoRow = page.locator('.my-lot').filter({ has: page.locator(`a[href="/operador/lotes/${photoLot.id}"]`) })
  await photoRow.getByText('Publicado', { exact: true }).waitFor()
  await photoRow.getByText('0 de 12 packs reservados').waitFor()
  const listed = (status) => page.waitForResponse((response) => response.url().endsWith(`/lots?status=${status}`))
  const draftsListed = listed('draft')
  await page.getByRole('link', { name: 'Borradores' }).click()
  await draftsListed
  await page.locator('section[aria-label="Lotes del establecimiento"][aria-busy="false"]').waitFor()
  assert.equal(await page.locator(`.my-lot a[href="/operador/lotes/${photoLot.id}"]`).count(), 0)
  assert.equal(await page.locator('.my-lot').filter({ hasText: 'Publicado' }).count(), 0)
  const publishedListed = listed('published')
  await page.getByRole('link', { name: 'Publicados' }).click()
  await publishedListed
  await page.locator('section[aria-label="Lotes del establecimiento"][aria-busy="false"]').waitFor()
  await photoRow.getByRole('link', { name: 'Ver lote' }).click()
  await page.waitForURL(`${baseUrl}/operador/lotes/${photoLot.id}`)
  await page.getByRole('heading', { name: 'Lote publicado' }).waitFor()
  ok('mis lotes: el publicado aparece con sus reservas, los filtros por estado funcionan y el enlace abre el lote')

  assert.deepEqual(pageErrors, [])
  assert.deepEqual(rateLimited, [], 'la prueba no debe depender de respuestas 429')
  ok('ninguna respuesta 429 durante el recorrido')
  console.log('K011/K017 web lots: real API, worker, proxy, CSRF, draft, edit, conflict, photos, publish and errors checks passed')
} catch (error) {
  if (rateLimited.length > 0) console.error('Respuestas 429 durante la prueba:', rateLimited)
  throw error
} finally {
  await browser.close()
  await db.end()
}
