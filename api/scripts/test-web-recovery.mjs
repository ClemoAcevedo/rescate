import assert from 'node:assert/strict'
import { chromium } from './support/browser.mjs'

const base = (process.env.WEB_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const browser = await chromium.launch()
const csrfToken = 'controlled'
const session = { user: { id: 'user-recovery', email: 'operador@example.invalid' },
  operableEstablishments: [{ id: 'est-recovery', name: 'Panadería de prueba' }],
  expiresAt: '2030-01-15T22:00:00Z' }
const instant = '2030-01-15T18:00:00Z'
const lot = { id: 'lot-recovery', establishmentId: 'est-recovery', description: 'Un pack para retirar', quantity: 1,
  category: 'Panadería', address: 'Calle ficticia 123', conditions: null, latitude: -33.45, longitude: -70.66,
  timeZone: 'America/Santiago', pickupStartsAt: instant, pickupEndsAt: '2030-01-15T21:00:00Z',
  status: 'draft', version: 1, createdAt: instant, publishedAt: null }
const photo = { id: 'photo-recovery', position: 1, status: 'ready', createdAt: instant, width: 640, height: 480,
  rejectionReason: null, thumbnailUrl: null, displayUrl: null }
const emptyNotices = { items: [], page: 1, hasNextPage: false, unreadCount: 0 }
const error = (code, message = 'Respuesta controlada.', details) => ({ error: { code, message, details } })

async function checkLogin() {
  const page = await browser.newPage({ ignoreHTTPSErrors: true })
  let checkingFailed = true
  let loginAttempts = 0
  const email = session.user.email
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    switch (path) {
      case '/api/auth/session':
        return checkingFailed
          ? route.fulfill({ status: 503, json: error('SERVICE_UNAVAILABLE') })
          : route.fulfill({ json: { session: null, csrfToken } })
      case '/api/auth/login':
        assert.equal(route.request().headers()['x-csrf-token'], csrfToken)
        assert.equal(route.request().postDataJSON().email, email)
        loginAttempts++
        return loginAttempts === 1
          ? route.fulfill({ status: 422, json: error('VALIDATION_ERROR', 'Revisa los datos.',
            { issues: [{ path: '/email', message: 'Comprueba el correo.' }] }) })
          : route.fulfill({ json: { session, csrfToken } })
      case '/api/public/lots':
        return route.fulfill({ json: { items: [], page: 1, hasNextPage: false } })
      case '/api/notifications':
        return route.fulfill({ json: emptyNotices })
      default:
        throw new Error(`Ruta inesperada: ${path}`)
    }
  })
  try {
    await page.goto(base + '/login')
    const retry = page.getByRole('button', { name: 'Reintentar comprobación' })
    await retry.waitFor()
    await page.getByText(/El servicio no está disponible temporalmente/).waitFor()
    const field = page.getByRole('textbox', { name: /Correo electrónico/ })
    const submit = page.getByRole('button', { name: 'Iniciar sesión' })
    await field.fill(email)
    await page.getByLabel(/Contraseña/).fill('Clave ficticia de prueba')
    await submit.click()
    await page.getByRole('main').getByText(/No fue posible completar la solicitud/).waitFor()
    assert.equal(loginAttempts, 0, 'Una consulta fallida no habilita el envío sin token')

    checkingFailed = false
    await retry.click()
    await retry.waitFor({ state: 'hidden' })
    await submit.click()
    await page.getByText('Comprueba el correo.').waitFor()
    assert.equal(await field.getAttribute('aria-invalid'), 'true')
    assert.equal(await field.inputValue(), email)
    await submit.click()
    await page.waitForURL('**/lotes')
    const menu = page.getByRole('button', { name: /^Abrir menú(?:,|$)/ })
    if (await menu.isVisible()) await menu.click()
    await page.getByRole('button', { name: 'Cerrar sesión' }).waitFor()
    assert.equal(loginAttempts, 2)
    console.log('Sesión: indisponibilidad, bloqueo sin token, errores de campo y recuperación sin perder el correo.')
  } finally { await page.close() }
}

async function checkPhotos() {
  const page = await browser.newPage({ ignoreHTTPSErrors: true })
  const photosPath = `/api/lots/${lot.id}/photos`
  let entries = []
  let loads = 0
  let uploads = 0
  let deletes = 0
  const failures = [
    [429, 'RATE_LIMITED', /Espera 4 s/],
    [413, 'PAYLOAD_TOO_LARGE', /supera el máximo de 5 MiB/],
    [415, 'UNSUPPORTED_MEDIA_TYPE', /Usa una imagen JPEG/],
    [503, 'SERVICE_UNAVAILABLE', /publicar el lote sin fotos/],
    [409, 'CONFLICT', /Se actualizó la lista/],
  ]
  await page.route('**/api/**', route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/auth/session') return route.fulfill({ json: { session, csrfToken } })
    if (path === '/api/notifications') return route.fulfill({ json: emptyNotices })
    if (path === `/api/lots/${lot.id}`) return route.fulfill({ json: lot })
    if (path === photosPath && request.method() === 'GET') {
      loads++
      if (loads === 1) return route.fulfill({ status: 503, json: error('SERVICE_UNAVAILABLE') })
      return route.fulfill({ json: { items: entries, limit: 3 } })
    }
    if (path === photosPath && request.method() === 'POST') {
      assert.equal(request.headers()['x-csrf-token'], csrfToken)
      assert.equal(request.headers()['content-type'], 'image/png')
      const failure = failures[uploads++]
      if (failure) return route.fulfill({ status: failure[0], json: error(failure[1]),
        headers: failure[0] === 429 ? { 'retry-after': '4' } : {} })
      // La carga quedó registrada, pero el cliente perdió su respuesta.
      entries = [photo]
      return route.abort('failed')
    }
    if (path === `${photosPath}/${photo.id}` && request.method() === 'DELETE') {
      assert.equal(request.headers()['x-csrf-token'], csrfToken)
      if (++deletes === 1) return route.fulfill({ status: 429, json: error('RATE_LIMITED') })
      entries = []
      return route.fulfill({ status: 404, json: error('NOT_FOUND') })
    }
    throw new Error(`Ruta inesperada: ${request.method()} ${path}`)
  })
  try {
    await page.goto(base + `/operador/lotes/${lot.id}`)
    const panel = page.getByRole('region', { name: 'Fotos (opcional)' })
    await panel.getByText('No fue posible consultar las fotos.').waitFor()
    await panel.getByRole('button', { name: 'Reintentar' }).click()
    const add = panel.getByRole('button', { name: 'Agregar foto' })
    await add.waitFor()
    const input = panel.locator('input[type=file]')
    const file = { name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from('fixture controlado por HTTP') }
    await input.setInputFiles({ ...file, name: 'archivo.txt', mimeType: 'text/plain' })
    await panel.getByRole('alert').filter({ hasText: /Usa una imagen/ }).waitFor()
    assert.equal(uploads, 0, 'El archivo no admitido no llega a la API')
    const alert = panel.getByRole('alert')
    for (const [, , message] of failures) {
      await input.setInputFiles(file)
      await alert.filter({ hasText: message }).waitFor()
      await add.waitFor()
    }
    assert.equal(uploads, failures.length)
    await input.setInputFiles(file)
    await alert.filter({ hasText: /La foto podría haberse cargado/ }).waitFor()
    const remove = panel.getByRole('button', { name: 'Quitar foto 1' })
    await remove.waitFor()
    assert.equal(uploads, failures.length + 1, 'La reconciliación no reenvía el archivo')
    await remove.click()
    await alert.filter({ hasText: /Hay demasiadas solicitudes/ }).waitFor()
    await remove.click()
    await alert.filter({ hasText: /la foto ya no existe/ }).waitFor()
    await remove.waitFor({ state: 'detached' })
    assert.equal(deletes, 2)
    console.log('Fotos: consulta recuperable, errores de subida, carga incierta sin duplicados y reconciliación al quitar.')
  } finally { await page.close() }
}

try {
  await checkLogin()
  await checkPhotos()
} finally { await browser.close() }
