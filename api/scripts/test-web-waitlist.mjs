import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.WEB_URL ?? 'http://localhost:5173'
const browser = await chromium.launch()
const session = { user: { id: 'usr_waitlist', email: 'espera@example.test' }, operableEstablishments: [], expiresAt: '2030-01-15T22:00:00Z' }
const lot = { id: 'lot_test', description: 'Pack de panes.', conditions: 'Traer bolsa.', address: 'Calle 123', latitude: -33.45, longitude: -70.66, timeZone: 'America/Santiago', pickupStartsAt: '2030-01-15T18:00:00Z', pickupEndsAt: '2030-01-15T21:00:00Z' }
const waiting = { id: 'w_test', requestedQuantity: 10, status: 'waiting', offeredQuantity: null, offerExpiresAt: null, position: 2, reservationId: null, createdAt: '2030-01-14T12:00:00Z', endedAt: null, lot }
const offered = { ...waiting, status: 'offered', position: null, offeredQuantity: 4, offerExpiresAt: '2030-01-15T20:00:00Z' }
function terminal(entry, status) { return { ...entry, status, position: null, reservationId: status === 'accepted' ? 'res_test' : null, endedAt: '2030-01-15T19:00:00Z' } }
try {
  for (const scenario of ['waiting', 'partial', 'expiry', 'stale-clock', 'lost-accept', 'pending', 'decline', 'leave', 'waiting-expiry', 'forbidden', 'invalid', 'missing', 'anonymous', 'pagination', 'join', 'lost-join']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: scenario === 'partial' ? 1366 : 360, height: 800 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let current = structuredClone(['waiting', 'leave', 'waiting-expiry', 'join', 'lost-join'].includes(scenario) ? waiting : offered)
    if (scenario === 'waiting-expiry') {
      current.lot.pickupStartsAt = new Date(Date.now() - 1000).toISOString()
      current.lot.pickupEndsAt = new Date(Date.now() + 2500).toISOString()
    }
    if (scenario === 'invalid') current.reservationId = 'res_invalid'
    if (scenario === 'expiry') current.offerExpiresAt = new Date(Date.now() + 2500).toISOString()
    let attempts = 0
    let joins = []
    let release
    const pending = new Promise(resolve => { release = resolve })
    await page.route('**/api/**', async route => {
      const req = route.request()
      const url = new URL(req.url())
      const path = url.pathname
      if (path === '/api/auth/session') return route.fulfill({ json: { session: scenario === 'anonymous' ? null : session, csrfToken: 'controlled' } })
      if (path === '/api/waitlist') return route.fulfill({ json: { page: Number(url.searchParams.get('page')), hasNextPage: url.searchParams.get('page') === '1', items: [current] } })
      if (path === '/api/waitlist/w_test') return route.fulfill({ status: scenario === 'missing' ? 404 : 200, json: current })
      assert.equal(req.headers()['x-csrf-token'], 'controlled')
      if (path === '/api/public/lots/lot_test/waitlist') {
        joins.push(req.postDataJSON())
        if (scenario === 'lost-join' && joins.length === 1) return route.abort('failed')
        return route.fulfill({ status: 201, json: current })
      }
      assert.deepEqual(req.postDataJSON(), {})
      attempts++
      if (scenario === 'pending') await pending
      if (scenario === 'forbidden') return route.fulfill({ status: 403, json: {} })
      if (scenario === 'stale-clock') {
        current = terminal(current, 'expired')
        return route.fulfill({ status: 409, json: {} })
      }
      current = terminal(current, path.endsWith('/accept') ? 'accepted' : path.endsWith('/decline') ? 'declined' : 'left')
      if (scenario === 'lost-accept') return route.abort('failed')
      return route.fulfill({ json: current })
    })
    await page.goto(`${base}/${['join', 'lost-join'].includes(scenario) ? 'lotes/lot_test/espera' : scenario === 'pagination' ? 'espera' : 'espera/w_test'}`)
    if (scenario === 'anonymous') {
      await page.getByText('Inicia sesión para gestionar tu espera.').waitFor()
      assert.equal(attempts, 0)
    } else if (['join', 'lost-join'].includes(scenario)) {
      await page.getByLabel('Cantidad solicitada').fill('10')
      assert.equal(joins.length, 0)
      await page.getByRole('button', { name: 'Entrar voluntariamente a la espera' }).click()
      if (scenario === 'lost-join') {
        await page.getByRole('button', { name: 'Comprobar el mismo ingreso' }).waitFor()
        await page.reload()
        await page.getByRole('button', { name: 'Comprobar el mismo ingreso' }).click()
        assert.deepEqual(joins[0], joins[1])
      }
      await page.getByText('Tu posición en la cola: 2.', { exact: false }).waitFor()
      assert.equal(joins[0].quantity, 10)
      assert.match(joins[0].idempotencyKey, /^[0-9a-f-]{36}$/)
    } else if (scenario === 'pagination') {
      await page.getByRole('button', { name: 'Página siguiente' }).click()
      await page.getByText('Página 2', { exact: true }).waitFor()
    } else if (scenario === 'invalid' || scenario === 'missing') {
      await page.getByRole('alert').waitFor()
      assert.equal(await page.getByRole('button', { name: /Aceptar explícitamente/ }).count(), 0)
    } else if (scenario === 'waiting') {
      await page.getByText('Tu posición en la cola: 2.', { exact: false }).waitFor()
      assert.equal(await page.getByRole('button', { name: /Aceptar explícitamente/ }).count(), 0)
      assert.equal(attempts, 0)
    } else if (scenario === 'leave') {
      await page.getByRole('button', { name: 'Salir de la espera y perder mi posición' }).click()
      await page.getByText('Fuera de la cola', { exact: true }).waitFor()
    } else if (scenario === 'waiting-expiry') {
      await page.getByRole('button', { name: 'Salir de la espera y perder mi posición' }).waitFor()
      await page.getByText('Plazo finalizado', { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Salir de la espera y perder mi posición' }).count(), 0)
      assert.equal(attempts, 0)
    } else if (scenario === 'expiry') {
      await page.getByRole('button', { name: 'Aceptar explícitamente 4 packs' }).waitFor()
      await page.getByText('Plazo finalizado', { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: /Aceptar explícitamente/ }).count(), 0)
      assert.equal(attempts, 0)
    } else {
      const accept = page.getByRole('button', { name: 'Aceptar explícitamente 4 packs' })
      await accept.waitFor()
      assert.equal(attempts, 0)
      assert.equal(await page.getByRole('link', { name: 'Consultar mi reserva y código de retiro' }).count(), 0)
      if (scenario === 'decline') {
        await page.getByRole('button', { name: 'Rechazar oferta y salir de la cola' }).click()
        await page.getByText('Oferta rechazada', { exact: true }).waitFor()
      } else {
        // El reloj local conserva una oferta "vigente", pero la API rechaza el vencimiento real.
        await accept.click()
        if (scenario === 'pending') {
          await accept.click({ force: true })
          assert.equal(attempts, 1)
          release()
        }
        if (scenario === 'forbidden') {
          await page.getByText('Resultado por comprobar', { exact: true }).waitFor()
          assert.equal(await accept.isDisabled(), true)
          assert.equal(await page.getByRole('link', { name: 'Consultar mi reserva y código de retiro' }).count(), 0)
        } else if (scenario === 'lost-accept' || scenario === 'stale-clock') {
          await page.getByText('Resultado por comprobar', { exact: true }).waitFor()
          assert.equal(await accept.isDisabled(), true)
          await page.getByRole('button', { name: 'Consultar estado actualizado' }).click()
          await page.getByText(scenario === 'lost-accept' ? 'Oferta aceptada' : 'Solicitud vencida', { exact: true }).waitFor()
        } else await page.getByText('Oferta aceptada', { exact: true }).waitFor()
        const link = page.getByRole('link', { name: 'Consultar mi reserva y código de retiro' })
        if (scenario === 'stale-clock' || scenario === 'forbidden') assert.equal(await link.count(), 0)
        else assert.equal(await link.getAttribute('href'), '/reservas/res_test')
      }
      assert.equal(attempts, 1)
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${scenario}: overflow`)
    assert.deepEqual(errors, [])
    console.log(`OK ${scenario}`)
    await context.close()
  }
} finally { await browser.close() }
