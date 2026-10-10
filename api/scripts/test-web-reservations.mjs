import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// Contrato HTTP controlado en navegador; PostgreSQL/idempotencia real se prueban
// además en test:web:discovery y db:test:reservations dentro de Compose.
const base = process.env.WEB_URL ?? 'http://localhost:5173'
const browser = await chromium.launch()
const session = { user: { id: 'usr_reservations', email: 'reservas@example.test' }, operableEstablishments: [], expiresAt: '2030-01-15T22:00:00Z' }
const lot = { id: 'lot_test', description: 'Pack de panes surtidos.', conditions: null, address: 'Calle ficticia 123', latitude: -33.45, longitude: -70.66, timeZone: 'America/Santiago', pickupStartsAt: '2030-01-15T18:00:00Z', pickupEndsAt: '2030-01-15T21:00:00Z' }
const confirmed = { id: 'res_test', quantity: 2, status: 'confirmed', createdAt: '2030-01-14T12:00:00Z', endedAt: null, lot, pickupCode: '7KQ2M9XA' }
function terminal(status) { return { ...confirmed, status, endedAt: '2030-01-15T20:00:00Z', pickupCode: null } }
try {
  for (const scenario of ['pending', 'lost', 'conflict', 'forbidden', 'invalid', 'expiry', 'history', 'pagination', 'missing', 'anonymous']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 800 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text()) })
    let current = structuredClone(confirmed)
    if (scenario === 'expiry') {
      current.lot.pickupStartsAt = new Date(Date.now() - 1000).toISOString()
      current.lot.pickupEndsAt = new Date(Date.now() + 4000).toISOString()
    }
    if (scenario === 'invalid') current = { ...terminal('cancelled'), pickupCode: confirmed.pickupCode }
    let attempts = 0
    let release
    const pending = new Promise(resolve => { release = resolve })
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url())
      const path = url.pathname
      if (path === '/api/auth/session') return route.fulfill({ json: { session: scenario === 'anonymous' ? null : session, csrfToken: 'controlled' } })
      if (path === '/api/reservations') {
        const number = Number(url.searchParams.get('page'))
        const items = number === 2 ? [terminal('expired')] : [confirmed, terminal('cancelled'), terminal('delivered'), terminal('expired')]
        return route.fulfill({ json: { page: number, hasNextPage: number === 1, items: items.map(({ pickupCode, ...item }, index) => ({ ...item, id: `res_history_${number}_${index}` })) } })
      }
      if (path === '/api/reservations/res_test') return route.fulfill({ status: scenario === 'missing' ? 404 : 200, json: current })
      if (path === '/api/reservations/res_test/cancel') {
        assert.equal(route.request().headers()['x-csrf-token'], 'controlled')
        assert.deepEqual(route.request().postDataJSON(), {})
        attempts++
        if (scenario === 'pending') await pending
        if (scenario === 'conflict') { current = terminal('delivered'); return route.fulfill({ status: 409, json: {} }) }
        if (scenario === 'forbidden') return route.fulfill({ status: 403, json: {} })
        current = terminal('cancelled')
        if (scenario === 'lost' && attempts === 1) return route.abort('failed')
        return route.fulfill({ json: current })
      }
      throw new Error(`Ruta inesperada: ${path}`)
    })
    await page.goto(`${base}/${['history', 'pagination'].includes(scenario) ? 'reservas' : 'reservas/res_test'}`)
    if (scenario === 'history' || scenario === 'pagination') {
      await page.getByText('Retirada', { exact: true }).waitFor()
      assert.equal(await page.locator('.pickup-code').count(), 0)
      assert.equal(await page.getByText(confirmed.pickupCode, { exact: true }).count(), 0)
      if (scenario === 'pagination') {
        await page.getByRole('button', { name: 'Página siguiente' }).click()
        await page.getByText('Página 2', { exact: true }).waitFor()
        assert.equal(await page.getByText('Confirmada', { exact: true }).count(), 0)
      }
    } else if (scenario === 'anonymous') {
      await page.getByRole('link', { name: 'Iniciar sesión', exact: true }).last().waitFor()
      assert.equal(await page.locator('.pickup-code').count(), 0)
    } else if (scenario === 'invalid' || scenario === 'missing') {
      await page.getByRole('status').filter({ hasText: /No fue posible|no existe/ }).waitFor()
      assert.equal(await page.locator('.pickup-code').count(), 0)
    } else {
      await page.getByText(confirmed.pickupCode, { exact: true }).waitFor()
      if (scenario === 'expiry') {
        await page.getByText('Ventana finalizada', { exact: true }).waitFor()
        assert.equal(await page.locator('.pickup-code').count(), 0)
        assert.equal(await page.getByRole('button', { name: 'Cancelar reserva', exact: true }).count(), 0)
      } else {
        await page.getByRole('button', { name: 'Cancelar reserva', exact: true }).click()
        if (scenario === 'pending') {
          const button = page.getByRole('button', { name: 'Confirmar cancelación' })
          await button.focus()
          await button.press('Enter')
        } else await page.getByRole('button', { name: 'Confirmar cancelación' }).click()
        if (scenario === 'pending') {
          await page.getByRole('button', { name: 'Cancelando…' }).waitFor()
          assert.equal(await page.getByText('Cancelada', { exact: true }).count(), 0)
          assert.equal(await page.locator('.pickup-code').count(), 0)
          release()
        }
        if (scenario === 'lost') {
          await page.getByText(/No se recibió la confirmación/).waitFor()
          assert.equal(await page.getByText('Cancelada', { exact: true }).count(), 0)
          assert.equal(await page.locator('.pickup-code').count(), 0)
          await page.getByRole('button', { name: 'Reintentar cancelación' }).click()
          await page.getByText('Cancelada', { exact: true }).waitFor()
          assert.equal(attempts, 2)
        } else if (scenario === 'conflict' || scenario === 'forbidden') {
          await page.getByText(scenario === 'conflict' ? /La reserva ya terminó/ : /rechazada por seguridad/).waitFor()
          assert.equal(await page.locator('.pickup-code').count(), 0)
          assert.equal(await page.getByText('Cancelada', { exact: true }).count(), 0)
          await page.getByRole('button', { name: 'Consultar estado actualizado' }).click()
          await page.getByText(scenario === 'conflict' ? 'Retirada' : confirmed.pickupCode, { exact: true }).waitFor()
        } else await page.getByText('Cancelada', { exact: true }).waitFor()
      }
    }
    assert.deepEqual(errors, [])
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await context.close()
    console.log(`OK K023: ${scenario}`)
  }
  // Se pierde la respuesta de creación; recargar recupera intención aun sin stock.
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 } })
  const page = await context.newPage()
  let original
  let recover = false
  let creations = 0
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/session') return route.fulfill({ json: { session, csrfToken: 'controlled' } })
    if (path === '/api/public/lots/lot_test') return route.fulfill({ json: { ...lot, category: 'Panadería', quantity: 2, availableQuantity: original ? 0 : 2, photoUrl: null, photos: [], distanceKm: null } })
    if (path === '/api/public/lots/lot_test/reservations') {
      const body = route.request().postDataJSON()
      if (!original) { original = body; creations++ } else assert.deepEqual(body, original)
      if (!recover) return route.fulfill({ status: 502, contentType: 'text/html', body: 'Bad Gateway' })
      return route.fulfill({ status: 201, json: { id: 'res_test', lotId: lot.id, quantity: body.quantity, status: 'confirmed', createdAt: confirmed.createdAt } })
    }
    if (path === '/api/reservations/res_test') return route.fulfill({ json: terminal('expired') })
    throw new Error(`Ruta inesperada: ${path}`)
  })
  await page.goto(`${base}/lotes/lot_test`)
  await page.getByRole('button', { name: 'Confirmar reserva' }).click()
  await page.getByRole('button', { name: 'Comprobar la misma solicitud' }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: 'Comprobar la misma solicitud' }).waitFor()
  assert.equal(await page.getByRole('spinbutton').isDisabled(), true)
  recover = true
  await page.getByRole('button', { name: 'Comprobar la misma solicitud' }).click()
  await page.getByRole('link', { name: 'Ver mi reserva' }).click()
  await page.getByText('Vencida', { exact: true }).waitFor()
  assert.equal(await page.locator('.pickup-code').count(), 0)
  assert.equal(creations, 1)
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).length), 0)
  await context.close()
  console.log('OK K023: intención recuperada tras recarga sin duplicar; estado vigente terminal')
} finally { await browser.close() }
