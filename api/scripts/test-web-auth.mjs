import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const baseUrl = (process.env.WEB_URL ?? 'https://localhost:5174').replace(/\/$/, '')
const email = `k009-${Date.now()}@example.com`
const password = 'K009-authentication-test-password'

function assertJson(response, status, keys) {
  assert.equal(response.status(), status)
  assert.match(response.headers()['content-type'] ?? '', /^application\/json\b/i)
  return response.json().then((body) => {
    assert.deepEqual(Object.keys(body).sort(), [...keys].sort())
    return body
  })
}

async function waitForApiResponse(page, path, action) {
  const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === path)
  await action()
  return responsePromise
}

async function assertResponsiveKeyboardLayout(page, viewport) {
  await page.setViewportSize(viewport)
  await page.goto(`${baseUrl}/registro`)
  await page.getByRole('button', { name: 'Crear cuenta' }).waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)

  for (const selector of ['input[name="email"]', 'input[name="password"]', 'button[type="submit"]', 'a[href="/login"]']) {
    const control = selector === 'a[href="/login"]' ? page.locator(selector).last() : page.locator(selector)
    await control.scrollIntoViewIfNeeded()
    await control.focus()
    assert.equal(await control.evaluate((element) => document.activeElement === element), true)
  }

  await page.screenshot({ path: `/tmp/rescate-k009-${viewport.width}x${viewport.height}.png` })
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 768 } })
const page = await context.newPage()

try {
  await assertResponsiveKeyboardLayout(page, { width: 360, height: 800 })
  await assertResponsiveKeyboardLayout(page, { width: 1366, height: 768 })

  await page.goto(`${baseUrl}/conexion`)
  const healthResponse = await waitForApiResponse(page, '/api/health', () => page.getByRole('button', { name: 'Comprobar conexión' }).click())
  await assertJson(healthResponse, 200, ['status'])

  const sessionResponse = await waitForApiResponse(page, '/api/auth/session', () => page.goto(`${baseUrl}/registro`))
  const anonymousSession = await assertJson(sessionResponse, 200, ['session', 'csrfToken'])
  assert.equal(anonymousSession.session, null)
  await page.locator('input[name="email"]').fill(email)
  await page.locator('input[name="password"]').fill(password)
  const registerResponse = await waitForApiResponse(page, '/api/auth/register', () => page.getByRole('button', { name: 'Crear cuenta' }).click())
  await assertJson(registerResponse, 201, ['user'])
  const registerResult = page.getByRole('status')
  await assert.match(await registerResult.textContent(), /no inicia sesión/i)
  assert.match(await registerResult.getAttribute('class'), /ui-alert--success/)

  const reloadResponse = await waitForApiResponse(page, '/api/auth/session', () => page.reload())
  assert.equal((await assertJson(reloadResponse, 200, ['session', 'csrfToken'])).session, null)

  await page.goto(`${baseUrl}/login`)
  await page.locator('input[name="email"]').fill(email)
  await page.locator('input[name="password"]').fill('contraseña incorrecta de prueba')
  const credentialsResponse = await waitForApiResponse(page, '/api/auth/login', () => page.getByRole('button', { name: 'Iniciar sesión' }).click())
  const credentialsError = await assertJson(credentialsResponse, 401, ['error'])
  assert.equal(credentialsError.error.code, 'UNAUTHENTICATED')
  const credentialsAlert = page.getByRole('alert')
  await assert.match(await credentialsAlert.textContent(), /correo o la contraseña/i)
  assert.match(await credentialsAlert.getAttribute('class'), /ui-alert--danger/)

  await page.locator('input[name="password"]').fill(password)
  const loginResponse = await waitForApiResponse(page, '/api/auth/login', () => page.getByRole('button', { name: 'Iniciar sesión' }).click())
  const login = await assertJson(loginResponse, 200, ['session', 'csrfToken'])
  assert.ok(login.session)
  await page.waitForURL(`${baseUrl}/lotes`)

  const authenticatedSessionResponse = await waitForApiResponse(page, '/api/auth/session', () => page.reload())
  assert.ok((await assertJson(authenticatedSessionResponse, 200, ['session', 'csrfToken'])).session)

  const csrfFailure = await page.evaluate(async () => {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'invalid' },
      body: JSON.stringify({ email: 'forbidden@example.com', password: 'K009-authentication-test-password' }),
    })
    const body = await response.json()
    return { status: response.status, contentType: response.headers.get('content-type'), keys: Object.keys(body), code: body.error?.code }
  })
  assert.equal(csrfFailure.status, 403)
  assert.match(csrfFailure.contentType ?? '', /^application\/json\b/i)
  assert.deepEqual(csrfFailure.keys, ['error'])
  assert.equal(csrfFailure.code, 'FORBIDDEN')

  const logoutResponse = await waitForApiResponse(page, '/api/auth/logout', () => page.getByRole('button', { name: 'Cerrar sesión' }).click())
  assert.equal(logoutResponse.status(), 204)
  assert.equal(await logoutResponse.text(), '')
  await page.getByRole('link', { name: 'Iniciar sesión' }).waitFor({ state: 'visible' })

  console.log('K009 web auth: real API, proxy, CSRF, session and responsive checks passed')
} finally {
  await browser.close()
}
