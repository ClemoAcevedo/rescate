import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const origin = process.env.WEB_URL
assert.ok(origin, 'Configura WEB_URL con el origen HTTPS del despliegue Vercel')
assert.equal(new URL(origin).origin, origin, 'WEB_URL debe ser un origen exacto, sin ruta')
assert.equal(new URL(origin).protocol, 'https:')
const email = process.env.DEPLOY_SMOKE_EMAIL
const password = process.env.DEPLOY_SMOKE_PASSWORD
assert.equal(Boolean(email), Boolean(password), 'Configura ambas credenciales de prueba o ninguna')

const browser = await chromium.launch({ headless: true })
// Se verifica el certificado público; no se admiten certificados inválidos.
const context = await browser.newContext()
const page = await context.newPage()
const pageErrors = []
const failedRequests = []
page.on('pageerror', error => pageErrors.push(error.message))
page.on('requestfailed', request => {
  const path = new URL(request.url()).pathname
  failedRequests.push(`${request.method()} ${path}: ${request.failure()?.errorText ?? 'fallo de red'}`)
})
page.setDefaultTimeout(30000)

try {
  if (process.env.DEPLOY_SHA) {
    const release = await context.request.get(`${origin}/release.json`, { headers: { 'Cache-Control': 'no-cache' } })
    assert.equal(release.status(), 200)
    assert.deepEqual(await release.json(), { commit: process.env.DEPLOY_SHA })
    console.log('PASS: dominio público sirve el commit que aprobó CI')
  }
  for (const path of ['/conexion', '/registro', '/login', '/lotes']) {
    const response = await page.goto(`${origin}${path}`)
    assert.equal(response.status(), 200, `fallback SPA en ${path}`)
    await page.locator('#root > *').first().waitFor()
  }
  await page.goto(`${origin}/conexion`)
  const healthResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/health')
  await page.getByRole('button', { name: 'Comprobar conexión' }).click()
  const health = await healthResponse
  assert.equal(health.status(), 200)
  // K036: después de desplegar API y worker, la base responde y el worker tiene latido reciente.
  assert.deepEqual(await health.json(), { status: 'ok', database: 'ok', worker: 'ok' })
  console.log('PASS: web compilada, rutas SPA y botón de conexión → API')

  const session = await page.evaluate(async () => {
    const response = await fetch('/api/auth/session')
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') }
  })
  assert.equal(session.status, 200)
  assert.equal(session.body.session, null)
  assert.ok(session.body.csrfToken)
  assert.match(session.cache, /no-store/)
  const csrf = (await context.cookies(origin)).find(cookie => cookie.name === '__Host-rescate_csrf')
  assert.ok(csrf, 'Vercel debe reenviar Set-Cookie del backend')
  assert.equal(csrf.domain, new URL(origin).hostname)
  assert.equal(csrf.secure, true)
  assert.equal(csrf.httpOnly, true)
  assert.equal(csrf.sameSite, 'Lax')
  assert.equal(csrf.path, '/')
  console.log('PASS: sesión anónima y cookie CSRF del mismo origen')

  const search = await page.evaluate(async () => {
    const response = await fetch('/api/public/lots?latitude=-33.45&longitude=-70.66&radiusKm=5')
    return { status: response.status, body: await response.json() }
  })
  assert.equal(search.status, 200, 'búsqueda pública debe consultar PostGIS')
  assert.ok(Array.isArray(search.body.items))
  console.log('PASS: búsqueda pública → PostgreSQL/PostGIS')

  if (email && password) {
    await page.goto(`${origin}/login`)
    await page.locator('input[name="email"]').fill(email)
    await page.locator('input[name="password"]').fill(password)
    const loginResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login')
    await page.getByRole('button', { name: 'Iniciar sesión' }).click()
    const login = await loginResponse
    assert.equal(login.status(), 200, 'login real con Origin y CSRF')
    assert.ok((await login.json()).session)
    await page.waitForURL(`${origin}/lotes`)
    const sessionCookie = (await context.cookies(origin)).find(cookie => cookie.name === '__Host-rescate_session')
    assert.ok(sessionCookie?.secure && sessionCookie.httpOnly)
    assert.equal(sessionCookie.domain, new URL(origin).hostname)
    // Rehidratar el proveedor de autenticación desde la cookie emitida por el
    // login antes de probar acciones protegidas. La respuesta de fetch directa
    // solo verifica el servidor y no actualiza el token CSRF en la aplicación.
    const persistedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/session')
    await page.reload()
    const persisted = await (await persistedResponse).json()
    assert.ok(persisted.session)
    assert.equal(typeof persisted.csrfToken, 'string', 'la sesión autenticada debe rehidratar también el token CSRF')
    assert.ok(persisted.csrfToken.length > 0, 'la sesión autenticada debe rehidratar también el token CSRF')

    const sessionStatus = page.locator('.session-status')
    const logoutButton = page.getByRole('button', { name: 'Cerrar sesión', exact: true })
    try {
      await sessionStatus.waitFor({ state: 'visible', timeout: 10000 })
      await logoutButton.waitFor({ state: 'visible', timeout: 10000 })
      assert.ok(await logoutButton.isEnabled(), 'el botón de logout debe estar habilitado')
    } catch (error) {
      const sessionVisible = await sessionStatus.isVisible().catch(() => false)
      const buttonVisible = await logoutButton.isVisible().catch(() => false)
      const sessionNotice = await page.locator('.session-notice [role="alert"]').allTextContents().catch(() => [])
      console.error('Diagnóstico de logout antes del click:', JSON.stringify({
        apiSession: Boolean(persisted.session), csrfTokenReady: Boolean(persisted.csrfToken),
        sessionVisible, buttonVisible, sessionNotice, pageErrors: pageErrors.length, failedRequests,
      }))
      throw error
    }

    let logoutResponse
    try {
      const [response] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout', { timeout: 15000 }),
        logoutButton.click(),
      ])
      logoutResponse = response
    } catch (error) {
      const sessionVisible = await sessionStatus.isVisible().catch(() => false)
      const buttonEnabled = await logoutButton.isEnabled().catch(() => false)
      const buttonBusy = await logoutButton.getAttribute('aria-busy').catch(() => null)
      const sessionNotice = await page.locator('.session-notice [role="alert"]').allTextContents().catch(() => [])
      console.error('Diagnóstico de logout después del click:', JSON.stringify({
        csrfTokenReady: Boolean(persisted.csrfToken), sessionVisible, buttonEnabled, buttonBusy,
        sessionNotice, pageErrors: pageErrors.length, failedRequests,
      }))
      throw error
    }
    assert.equal((await logoutResponse).status(), 204)
    const loggedOut = await page.evaluate(async () => (await fetch('/api/auth/session')).json())
    assert.equal(loggedOut.session, null)
    console.log('PASS: login, sesión persistida y logout con cookies Secure y CSRF')
  }
  assert.deepEqual(pageErrors, [])
} finally {
  await browser.close()
}
