import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// Respuestas HTTP controladas: requiere Vite sin VITE_AUTH_MOCK_SCENARIO.
const baseUrl = (process.env.WEB_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const browser = await chromium.launch({ headless: true })

try {
  for (const scenario of ['network', 'forbidden']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    let active = true
    let attempts = 0
    let confirmLogout
    const confirmation = new Promise(resolve => { confirmLogout = resolve })
    const session = {
      user: { id: 'usr_controlled', email: 'persona@example.com' },
      operableEstablishments: [],
      expiresAt: '2030-01-15T22:00:00Z',
    }
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/auth/session') {
        return route.fulfill({ json: { session: active ? session : null, csrfToken: 'controlled' } })
      }
      if (path === '/api/auth/logout') {
        attempts += 1
        if (attempts === 1) {
          if (scenario === 'network') return route.abort('failed')
          return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'No se permite esta operación.' } } })
        }
        await confirmation
        active = false
        return route.fulfill({ status: 204 })
      }
      throw new Error(`Solicitud inesperada: ${path}`)
    })
    await page.goto(`${baseUrl}/lotes`)
    const logout = page.getByRole('button', { name: 'Cerrar sesión' })
    await logout.click()
    const alert = page.getByRole('alert')
    await alert.waitFor({ state: 'visible' })
    assert.match(await alert.textContent(), scenario === 'network' ? /conexión/ : /seguridad o permisos/)
    assert.equal(await logout.isEnabled(), true)
    assert.equal(await page.getByText('Sesión: persona@example.com', { exact: true }).isVisible(), true)
    assert.equal(await page.getByRole('button', { name: 'Reintentar comprobación' }).count(), 0)
    assert.equal(attempts, 1)
    await logout.click()
    await page.waitForFunction(() => document.querySelector('button[aria-busy="true"]') !== null)
    assert.equal(await page.getByText('Sesión: persona@example.com', { exact: true }).isVisible(), true)
    await alert.waitFor({ state: 'hidden' })
    confirmLogout()
    await page.getByRole('link', { name: 'Iniciar sesión' }).waitFor({ state: 'visible' })
    assert.equal(await logout.count(), 0)
    assert.equal(attempts, 2)
    assert.deepEqual(pageErrors, [])
    await context.close()
    console.log(`K009 logout ${scenario}: aviso visible, sesión conservada y reintento confirmado`)
  }
} finally {
  await browser.close()
}
