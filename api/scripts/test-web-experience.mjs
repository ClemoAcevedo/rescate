import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { createServer } from '../../web/node_modules/vite/dist/node/index.js'
import { chromium } from './support/browser.mjs'

// K050: regresión de obstáculos reproducibles; HTTP controlado, sin sesiones humanas.
const root = fileURLToPath(new URL('../../web/', import.meta.url))
const vite = process.env.WEB_URL ? null : await createServer({ root, server: { host: '127.0.0.1', port: 0 } })
await vite?.listen()
const base = (process.env.WEB_URL ?? vite.resolvedUrls.local[0]).replace(/\/$/, '')
const browser = await chromium.launch()
const evidence = process.env.UX_SCREENSHOT_DIR
if (evidence) await mkdir(evidence, { recursive: true })
const session = { user: { id: 'usr_test', email: 'ux@example.test' }, operableEstablishments: [], expiresAt: '2030-01-15T22:00:00Z' }
const lot = { id: 'lot_test', description: 'Pack de panes para compartir', category: 'Panadería', quantity: 10, availableQuantity: 0, conditions: 'Traer bolsa.', address: 'Dirección de retiro '.repeat(15), latitude: -33.45, longitude: -70.66, timeZone: 'America/Santiago', pickupStartsAt: '2030-01-15T18:00:00Z', pickupEndsAt: '2030-01-15T21:00:00Z', photos: [], photoUrl: null, distanceKm: null }
const entry = { id: 'w_test', lot, requestedQuantity: 10, offeredQuantity: 4, offerExpiresAt: '2030-01-15T20:00:00Z', position: null, reservationId: null, status: 'offered', createdAt: '2030-01-14T12:00:00Z', endedAt: null }
const notice = { id: 'notice_test', kind: 'message_from_establishment', createdAt: entry.createdAt, readAt: null, lot: { id: lot.id, description: lot.description }, quantity: 4, waitlistEntryId: null, reservationId: 'res_test', offerExpiresAt: null }
let failures = 0
try {
  for (const width of [360, 1366]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', ignoreHTTPSErrors: true })
    const page = await context.newPage()
    page.setDefaultTimeout(4000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let notices = 'ready'
    let failWait = false
    let failReservation = false
    let offline = false
    const messages = []
    const sends = []
    let loseSend = true
    await page.route('**/api/**', async route => {
      const request = route.request()
      const url = new URL(request.url())
      const path = url.pathname
      if (offline || (failWait && path === '/api/waitlist/w_test') || (failReservation && path === '/api/reservations/res_test')) return route.abort('internetdisconnected')
      let json
      if (path === '/api/auth/session') json = { session, csrfToken: 'controlled' }
      else if (path === '/api/notifications' && notices === 'error') return route.abort('failed')
      else if (path === '/api/notifications') json = { items: notices === 'empty' ? [] : [notice], page: 1, hasNextPage: false, unreadCount: notice.readAt ? 0 : 1 }
      else if (path === '/api/notifications/notice_test/read') json = { ...notice, readAt: entry.createdAt }
      else if (path === '/api/waitlist/w_test') json = entry
      else if (path === '/api/reservations/res_test') json = { id: 'res_test', lot, quantity: 4, status: 'confirmed', pickupCode: '7KQ2M9XA', createdAt: entry.createdAt, endedAt: null }
      else if (path === '/api/reservations/res_test/messages') {
        if (request.method() === 'POST') {
          const intent = request.postDataJSON(); sends.push(intent)
          let message = messages.find(item => item.text === intent.text)
          if (!message) { message = { id: `msg_${messages.length}`, sequence: messages.length + 1, text: intent.text, author: 'holder', mine: true, createdAt: entry.createdAt }; messages.push(message) }
          if (loseSend) { loseSend = false; return route.abort('failed') }
          json = { id: message.id, sequence: message.sequence, createdAt: message.createdAt }
        } else json = { items: messages.filter(item => item.sequence > Number(url.searchParams.get('after'))), hasMore: false, open: true }
      } else throw new Error(`Ruta inesperada: ${path}`)
      return route.fulfill({ json })
    })
    async function check(name, action) {
      try { await action(); console.log(`OK ${width}px: ${name}`) }
      catch (error) { failures++; console.error(`FAIL ${width}px: ${name}: ${error.message}`) }
      if (evidence) await page.screenshot({ path: `${evidence}/${width}-${name}.png`, fullPage: true })
    }
    async function activate(role, name) {
      const target = page.getByRole(role, { name, exact: true })
      await target.waitFor()
      for (let i = 0; i < 80; i++) {
        if (await target.evaluate(el => el === document.activeElement)) { await page.keyboard.press('Enter'); return }
        await page.keyboard.press('Tab')
      }
      assert.fail(`Inalcanzable con Tab: ${name}`)
    }
    async function fits() { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Sin desborde') }
    await page.goto(base + '/reservas/res_test')
    await page.getByText('7KQ2M9XA', { exact: true }).waitFor()
    await check('reserva-red', async () => {
      failReservation = true
      await activate('button', 'Consultar estado actualizado')
      await page.getByText(/No fue posible comprobar la reserva/).waitFor()
      assert.equal(await page.getByRole('heading', { name: lot.description }).count(), 1, 'Conserva los datos de retiro al fallar la consulta')
      assert.equal(await page.getByText('7KQ2M9XA', { exact: true }).count(), 0, 'Oculta el código sin vigencia comprobada')
      assert.equal(await page.getByRole('button', { name: 'Cancelar reserva', exact: true }).isDisabled(), true)
      await fits()
    })
    await context.setOffline(true)
    failReservation = false
    await context.setOffline(false)
    await page.getByText('7KQ2M9XA', { exact: true }).waitFor()
    await page.goto(base + '/espera/w_test')
    await page.getByText('Oferta pendiente de aceptación', { exact: true }).waitFor()
    await check('espera-red', async () => {
      failWait = true
      await activate('button', 'Consultar estado actualizado')
      await page.getByRole('alert').waitFor()
      assert.equal(await page.getByRole('heading', { name: lot.description }).count(), 1, 'Conserva la oferta visible al fallar la consulta')
      assert.equal(await page.getByRole('button', { name: 'Aceptar explícitamente 4 packs' }).isDisabled(), true)
      await fits()
    })
    await context.setOffline(true)
    failWait = false
    await context.setOffline(false)
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(el => el.textContent === 'Aceptar explícitamente 4 packs' && !el.disabled))
    await check('avisos-vacio-error', async () => {
      notices = 'empty'
      await page.goto(base + '/avisos')
      await page.getByText(/No hay avisos en esta página/).waitFor()
      await fits()
      notices = 'error'
      await page.goto(base + '/avisos')
      await page.getByRole('button', { name: 'Reintentar', exact: true }).waitFor()
      notices = 'ready'
      await activate('button', 'Reintentar')
      await page.getByRole('heading', { name: 'Mensaje del establecimiento', exact: true }).waitFor()
      await fits()
    })
    await activate('button', 'Abrir conversación')
    await page.getByRole('textbox', { name: 'Mensaje (obligatorio)' }).waitFor()
    await check('chat-vacio', async () => {
      await page.getByText('Aún no hay mensajes.', { exact: true }).waitFor()
      assert.equal(await page.getByRole('log', { name: 'Mensajes' }).count(), 1, 'Mensajes nuevos anunciados por una región log')
      await fits()
    })
    await check('chat-reintento', async () => {
      const input = page.getByRole('textbox', { name: 'Mensaje (obligatorio)' })
      await activate('button', 'Consultar conversación')
      for (let i = 0; i < 80 && !(await input.evaluate(el => el === document.activeElement)); i++) await page.keyboard.press('Tab')
      assert.equal(await input.evaluate(el => el === document.activeElement), true)
      await page.keyboard.type('Mensaje de prueba')
      await activate('button', 'Enviar mensaje')
      await activate('button', 'Reintentar el mismo mensaje')
      await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA')
      assert.equal(sends.length, 2)
      assert.deepEqual(sends[0], sends[1], 'Reintenta la misma intención')
      assert.equal(messages.length, 1)
      await fits()
    })
    await check('chat-recibir', async () => {
      messages.push({ id: 'msg_remote', sequence: 2, text: 'Respuesta del establecimiento. '.repeat(30), author: 'operator', mine: false, createdAt: entry.createdAt })
      await activate('button', 'Consultar conversación')
      await page.getByText(messages[1].text.trim(), { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Consultar conversación' }).evaluate(el => el === document.activeElement), true, 'Recibir mensajes conserva el foco')
      await fits()
    })
    await page.goto(base + '/avisos')
    await page.getByRole('button', { name: 'Abrir conversación', exact: true }).waitFor()
    // Mantiene la SPA/sesión montada; simula navegador offline y errores de transporte.
    offline = true
    await context.setOffline(true)
    await check('chat-sin-conexion', async () => {
      await activate('button', 'Abrir conversación')
      await page.getByText(/Sin conexión/).waitFor()
      assert.equal(await page.locator('.chat__messages[aria-busy="true"]').count(), 0, 'No queda carga indefinida')
      await fits()
    })
    offline = false
    await context.setOffline(false)
    await page.locator('.chat__messages li').filter({ hasText: 'Mensaje de prueba' }).waitFor()
    assert.deepEqual(errors, [])
    await context.close()
  }
} finally { await browser.close(); await vite?.close() }
assert.equal(failures, 0, `${failures} obstáculos de experiencia/accesibilidad`)
