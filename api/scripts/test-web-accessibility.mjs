import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// Recorrido de teclado con HTTP controlado; no sustituye sesiones con personas.
const base = process.env.WEB_URL ?? 'http://localhost:5173'
const browser = await chromium.launch()
const session = { user: { id: 'usr_a11y', email: 'teclado@example.test' }, operableEstablishments: [], expiresAt: '2030-01-15T22:00:00Z' }
const lot = { id: 'lot_test', description: 'Pack de panes.', category: 'Panadería', quantity: 10, availableQuantity: 10, conditions: 'Traer bolsa.', address: 'Calle 123', latitude: -33.45, longitude: -70.66, timeZone: 'America/Santiago', pickupStartsAt: '2030-01-15T18:00:00Z', pickupEndsAt: '2030-01-15T21:00:00Z', photos: [], photoUrl: null, distanceKm: null }
const reservation = { id: 'res_test', lot, quantity: 1, status: 'confirmed', pickupCode: '7KQ2M9XA', createdAt: '2030-01-14T12:00:00Z', endedAt: null }
try {
  for (const width of [360, 1366]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', ignoreHTTPSErrors: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let current = structuredClone(reservation)
    let wait = { id: 'w_test', lot, requestedQuantity: 10, offeredQuantity: null, offerExpiresAt: null, position: 2, reservationId: null, status: 'waiting', createdAt: current.createdAt, endedAt: null }
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname
      let json
      if (path === '/api/auth/session') json = { session, csrfToken: 'controlled' }
      else if (path === '/api/notifications') json = { items: [], page: 1, hasNextPage: false, unreadCount: 0 }
      else if (path === '/api/public/lots') json = { items: [lot], page: 1, hasNextPage: false }
      else if (path === '/api/public/lots/lot_test') json = lot
      else if (path === '/api/public/lots/lot_test/reservations') json = { id: current.id, lotId: lot.id, quantity: 1, status: 'confirmed', createdAt: current.createdAt }
      else if (path === '/api/reservations/res_test') json = current
      else if (path === '/api/reservations/res_test/cancel') json = current = { ...current, status: 'cancelled', pickupCode: null, endedAt: '2030-01-15T19:00:00Z' }
      else if (path === '/api/waitlist/w_test') json = wait
      else if (path === '/api/waitlist/w_test/accept') {
        current = { ...reservation, quantity: 4 }
        json = wait = { ...wait, status: 'accepted', reservationId: current.id, endedAt: '2030-01-15T19:00:00Z' }
      }
      else throw new Error(`Ruta inesperada: ${path}`)
      return route.fulfill({ json })
    })
    async function tabTo(locator) {
      await locator.waitFor({ state: 'visible' })
      for (let i = 0; i < 80; i++) {
        if (await locator.evaluate(el => el === document.activeElement)) {
          assert.equal(await locator.evaluate(el => [el, el.closest('.lot-card-public')].some(node => node && getComputedStyle(node).outlineStyle !== 'none')), true, 'Foco visible en control o tarjeta')
          return
        }
        await page.keyboard.press('Tab')
      }
      assert.fail(`No se alcanza con Tab: ${locator}`)
    }
    async function activate(role, name) {
      await tabTo(page.getByRole(role, { name, exact: true }))
      await page.keyboard.press('Enter')
    }
    async function expectFocus(locator) {
      // Esperar el efecto de React o requestAnimationFrame sin mover el foco desde el test.
      await locator.waitFor({ state: 'visible' })
      const element = await locator.elementHandle()
      try {
        await page.waitForFunction(el => el === document.activeElement, element, { timeout: 3000 })
      } finally { await element.dispose() }
    }
    async function fits() {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Sin desborde a ${width}`)
    }
    await page.goto(base + '/lotes')
    await page.getByRole('heading', { name: 'Pack de panes' }).waitFor()
    await activate('link', 'Saltar al contenido principal')
    await expectFocus(page.locator('main'))
    await tabTo(page.getByLabel('Categoría', { exact: true }))
    await page.keyboard.type('Panadería')
    await activate('button', 'Buscar lotes')
    await page.getByRole('heading', { name: 'Pack de panes' }).waitFor()
    await fits()
    await activate('link', 'Pack de panes')
    await page.getByLabel('Cantidad de packs (obligatorio)', { exact: true }).waitFor()
    await expectFocus(page.locator('main'))
    await fits()
    await activate('button', 'Confirmar reserva')
    await page.getByRole('heading', { name: 'Solicitud registrada por 1 pack' }).waitFor()
    await expectFocus(page.locator('.reservation-confirmation'))
    await activate('link', 'Ver mi reserva')
    await page.getByText(current.pickupCode, { exact: true }).waitFor()
    await fits()
    await activate('button', 'Cancelar reserva')
    const confirm = page.getByRole('button', { name: 'Confirmar cancelación', exact: true })
    await expectFocus(confirm)
    await activate('button', 'Conservar reserva')
    await expectFocus(page.getByRole('button', { name: 'Cancelar reserva', exact: true }))
    await page.keyboard.press('Enter')
    await expectFocus(confirm)
    await page.keyboard.press('Enter')
    await page.getByText('Cancelada', { exact: true }).waitFor()
    await expectFocus(page.locator('.reservation-result'))
    assert.equal(await page.locator('.pickup-code').count(), 0)
    await fits()
    await page.goto(base + '/espera/w_test')
    await page.getByText(/Esperar no retiene packs ni crea una reserva/).waitFor()
    await fits()
    wait = { ...wait, status: 'offered', position: null, offeredQuantity: 4, offerExpiresAt: '2030-01-15T20:00:00Z' }
    await activate('button', 'Consultar estado actualizado')
    await page.getByText(/Aún no tienes una reserva/).waitFor()
    await fits()
    await activate('button', 'Aceptar explícitamente 4 packs')
    await page.getByText('Oferta aceptada', { exact: true }).waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'status')
    await activate('link', 'Consultar mi reserva y código de retiro')
    await page.getByText('Confirmada', { exact: true }).waitFor()
    await page.getByText(reservation.pickupCode, { exact: true }).waitFor()
    if (width === 360) {
      await activate('button', 'Abrir menú')
      await tabTo(page.getByRole('link', { name: 'Mis esperas', exact: true }))
      await page.keyboard.press('Escape')
      await expectFocus(page.getByRole('button', { name: 'Abrir menú' }))
    }
    await fits()
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`OK K033: explorar, reservar, conservar/cancelar, espera y oferta; teclado y foco; ${width}px`)
  }
} finally { await browser.close() }
