// K045: navegador con HTTP controlado validado contra OpenAPI; no publica incidencias.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../web/node_modules/vite/dist/node/index.js'
import { chromium } from './support/browser.mjs'
import { assertContract } from '../test/support/openapi.ts'

const root = fileURLToPath(new URL('../../web/', import.meta.url))
const vite = process.env.WEB_URL ? null : await createServer({ root, server: { host: '127.0.0.1', port: 0 } })
await vite?.listen()
const base = (process.env.WEB_URL ?? vite.resolvedUrls.local[0]).replace(/\/$/, '')
const browser = await chromium.launch()
const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const session = { user: { id: '33333333-3333-4333-8333-333333333333', email: 'k045@example.invalid' },
  operableEstablishments: [], expiresAt: '2035-01-15T22:00:00Z' }
const notice = (id, deliveredQuantity) => ({ id, kind: 'incident_version', createdAt: '2030-01-15T18:05:00Z', readAt: null,
  lot: { id: '44444444-4444-4444-8444-444444444444', description: 'Pack del lote cerrado' },
  quantity: 0, waitlistEntryId: null, reservationId: null, offerExpiresAt: null,
  incident: { id: '55555555-5555-4555-8555-555555555555', version: 1, status: 'open',
    reason: 'Contenido incorrecto.', instructions: 'No consumir.\nContactar al local.', relation: deliveredQuantity > 0 ? 'received' : 'committed', lotClosed: true } })
try {
  for (const width of [360, 1366]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true,
      timezoneId: 'Asia/Tokyo', reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let items = [], failHistory = true, failRead = true, reads = 0
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname.slice(4)
      const respond = (status, body) => {
        assertContract(request.method(), path, new Response(null, { status, headers: { 'cache-control': 'no-store' } }), body)
        return route.fulfill({ status, headers: { 'cache-control': 'no-store' }, json: body })
      }
      const error = code => ({ error: { code, message: 'No disponible.' } })
      if (path === '/auth/session') return route.fulfill({ json: { session, csrfToken: 'controlled' } })
      if (path === '/notifications') {
        if (url.searchParams.has('kind') && failHistory) return respond(503, error('SERVICE_UNAVAILABLE'))
        return respond(200, { items, page: 1, hasNextPage: false, unreadCount: items.filter(item => !item.readAt).length })
      }
      const found = items.find(item => path === `/notifications/${item.id}` || path === `/notifications/${item.id}/read`)
      if (!found) return respond(404, error('NOT_FOUND'))
      if (request.method() === 'POST') {
        assert.equal(request.headers()['x-csrf-token'], 'controlled')
        assert.deepEqual(request.postDataJSON(), {})
        if (failRead) { failRead = false; return respond(503, error('SERVICE_UNAVAILABLE')) }
        found.readAt ??= '2030-01-15T18:10:00Z'; reads++
      }
      return respond(200, found)
    })
    try {
      await page.goto(base + '/incidencias')
      await page.getByRole('alert').waitFor()
      failHistory = false
      await page.getByRole('button', { name: 'Reintentar', exact: true }).click()
      await page.getByText('No hay incidencias en esta página.').waitFor()
      await page.getByRole('link', { name: 'Volver a avisos', exact: true }).click()
      await page.getByText('No hay avisos en esta página.', { exact: false }).waitFor()
      await context.setOffline(true)
      items = [notice(firstId, 2), notice(secondId, 0)]
      await context.setOffline(false)
      await page.getByRole('article', { name: 'Aviso de incidencia' }).first().waitFor()
      assert.match(await page.locator('main').innerText(), /Recibiste packs/)
      assert.match(await page.locator('main').innerText(), /Tuviste un compromiso/)
      await page.getByRole('link', { name: 'Ver incidencia', exact: true }).first().click()
      await page.getByRole('heading', { name: 'Instrucciones', exact: true }).waitFor()
      assert.match(await page.locator('.incident-detail').innerText(), /Con entrega: recibiste packs/)
      assert.equal(reads, 0, 'abrir permite leer instrucciones antes de confirmar la lectura')
      assert.match(await page.locator('main time').innerText(), /15\/01\/2030 · 15:05/)
      await page.getByRole('button', { name: 'Marcar como leído', exact: true }).click()
      await page.getByText('No se pudo confirmar el registro de lectura.', { exact: false }).waitFor()
      assert.equal(items[0].readAt, null)
      await page.getByRole('button', { name: 'Marcar como leído', exact: true }).click()
      await page.getByRole('button', { name: 'Leído', exact: true }).waitFor()
      assert.equal(reads, 1)
      assert.match(await page.locator('.incident-detail__read').innerText(), /No acredita que hayas cumplido/)
      await page.getByRole('link', { name: 'Volver al historial de incidencias', exact: true }).click()
      await page.getByRole('heading', { name: 'Historial de incidencias', exact: true }).waitFor()
      const readButton = page.getByRole('button', { name: 'Leído', exact: true })
      await readButton.waitFor()
      assert.equal(await readButton.isDisabled(), true)
      assert.equal(await page.getByRole('button', { name: 'Marcar como leído', exact: true }).count(), 1)
      await page.getByRole('link', { name: 'Ver incidencia', exact: true }).nth(1).click()
      await page.getByText('Sin entrega registrada al fijarse esta versión:', { exact: false }).waitFor()
      // Texto extenso y caracteres HTML se muestran como texto y conservan saltos.
      items[1].incident.reason = 'Motivo largo con detalle. '.repeat(70)
      items[1].incident.instructions = '<script>contenido</script>\n' + 'Contactar al establecimiento. '.repeat(60)
      await page.reload()
      await page.getByRole('heading', { name: 'Instrucciones', exact: true }).waitFor()
      assert.equal(await page.locator('.incident-detail script').count(), 0)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.goto(base + '/incidencias/66666666-6666-4666-8666-666666666666')
      await page.getByText('El aviso no existe o no pertenece a tu cuenta.', { exact: true }).waitFor()
      assert.equal(await page.locator('.incident-detail').count(), 0)
      assert.deepEqual(errors, [])
      console.log(`OK K045 ${width}: error/reintento, vacío, reconexión, entrega, lectura, historial, instrucciones largas y 404`)
    } finally { await context.close() }
  }
} finally { await browser.close(); await vite?.close() }
