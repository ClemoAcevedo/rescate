import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { createServer } from '../../web/node_modules/vite/dist/node/index.js'
import { chromium } from './support/browser.mjs'

// HTTP controlado: retiene cada respuesta hasta medir la vista de carga.
// Sin API, PostgreSQL, cuentas nuevas ni dependencias adicionales.
const root = fileURLToPath(new URL('../../web/', import.meta.url))
const vite = process.env.WEB_URL ? null : await createServer({ root, server: { host: '127.0.0.1', port: 0 } })
await vite?.listen()
const base = (process.env.WEB_URL ?? vite.resolvedUrls.local[0]).replace(/\/$/, '')
const browser = await chromium.launch()
const screenshots = process.env.UX_SCREENSHOT_DIR
if (screenshots) await mkdir(screenshots, { recursive: true })
const instant = '2030-01-15T18:05:00Z'
const lot = { id: 'lot_ux', description: 'Pack de panes surtidos para compartir', category: 'Panadería', quantity: 10,
  availableQuantity: 10, conditions: 'Traer bolsa.', address: 'Calle ficticia 123', latitude: -33.45, longitude: -70.66,
  timeZone: 'America/Santiago', pickupStartsAt: instant, pickupEndsAt: '2030-01-15T21:00:00Z',
  photos: [], photoUrl: null, distanceKm: null }
const session = { user: { id: 'usr_ux', email: 'ux@example.test' },
  operableEstablishments: [{ id: 'est_ux', name: 'Almacén ficticio' }], expiresAt: '2030-01-15T22:00:00Z' }
const reservation = { id: 'res_ux', quantity: 2, status: 'confirmed', createdAt: instant, endedAt: null, lot, pickupCode: '7KQ2M9XA' }
const inventory = { free: 8, reserved: 2, offered: 0, delivered: 0, unassignable: 0 }
const panel = { establishment: { id: 'est_ux', name: 'Almacén ficticio', timeZone: lot.timeZone }, asOf: instant,
  current: { inventory, confirmedReservations: 1, activeOffers: 0, waitingRequests: 0,
    lots: [0, 1].map(index => ({ ...lot, id: `lot_${index}`, inventory, confirmedReservations: 1, activeOffers: 0, waitingRequests: 0 })) },
  period: { from: '2030-01-01', to: '2030-01-15', closedLots: 0,
    packs: { published: 0, delivered: 0, unassignable: 0 }, reservations: { confirmed: 0, cancelled: 0, expired: 0, delivered: 0 },
    deliveryRate: { numerator: 0, denominator: 0, value: null }, reservationExpiryRate: { numerator: 0, denominator: 0, value: null },
    excluded: { openLots: 2, draftLots: 0 } } }
const notification = { id: 'notice_ux', kind: 'reservation_confirmed', createdAt: instant, readAt: null,
  lot: { id: lot.id, description: lot.description }, quantity: 2, waitlistEntryId: null, reservationId: reservation.id, offerExpiresAt: null }
const incidentNotification = { ...notification, id: 'notice_incident', kind: 'incident_version', incident: {
  id: 'incident_ux', version: 1, status: 'open', reason: 'Contenido incorrecto.',
  instructions: 'No consumir. Contactar al local.', relation: 'received', lotClosed: true,
} }
const operatorLot = { ...lot, establishmentId: 'est_ux', status: 'published', version: 1, reservedQuantity: 2, paused: false,
  createdAt: instant, publishedAt: instant }
const fixtures = {
  '/api/notifications/notice_incident': incidentNotification,
  '/api/public/lots': { items: [0, 1, 2].map(index => ({ ...lot, id: `lot_${index}` })), page: 1, hasNextPage: false },
  '/api/public/lots/lot_ux': lot,
  '/api/reservations': { items: [0, 1, 2].map(index => ({ ...reservation, id: `res_${index}` })), page: 1, hasNextPage: false },
  '/api/reservations/res_ux': reservation,
  '/api/reservations/res_ux/messages': { items: [{ id: 'msg_ux', sequence: 1, author: 'operator', mine: false, text: 'Nos vemos en el retiro.', createdAt: instant }], hasMore: false, open: true },
  '/api/establishments/est_ux/panel': panel,
  '/api/establishments/est_ux/commitments': { items: [], page: 1, hasNextPage: false },
  '/api/establishments/est_ux/incidents': { items: [], page: 1, hasNextPage: false },
  '/api/establishments/est_ux/activity': { items: [{ id: 'event_ux', kind: 'lot_published', at: instant, lot, quantity: 10 }], page: 1, hasNextPage: false },
  '/api/establishments/est_ux/lots': { items: [0, 1, 2].map(index => ({ ...operatorLot, id: `lot_${index}` })), page: 1, hasNextPage: false },
  '/api/lots/lot_ux': operatorLot,
  '/api/lots/lot_ux/photos': { items: [], limit: 3 },
  '/api/lots/lot_ux/management': { lotId: lot.id, status: 'published', version: 1, paused: false, quantity: 10, inventory, history: [] },
}

const screens = [
  { path: '/lotes', target: '/api/public/lots', selector: '.lot-card-public', props: ['x', 'y', 'width', 'height'] },
  { path: '/lotes/lot_ux', target: '/api/public/lots/lot_ux', selector: '.lot-gallery > .lot-photo', props: ['x', 'y', 'width', 'height'] },
  { path: '/reservas', target: '/api/reservations', selector: '.reservations__list > li, .record-skeleton > li', props: ['x', 'y', 'width', 'height'] },
  { path: '/incidencias/notice_incident', target: '/api/notifications/notice_incident', selector: '.incident-detail, .incident-detail__action', props: ['x', 'width'] },
  { path: '/incidencias', target: '/api/notifications', selector: '.notifications__list .notification', props: ['x', 'width'] },
  { path: '/avisos', target: '/api/notifications', selector: '.notifications__list .notification', props: ['x', 'y', 'width', 'height'] },
  { path: '/reservas/res_ux/chat', target: '/api/reservations/res_ux/messages', selector: '.chat form', props: ['x', 'y', 'width', 'height'] },
  { path: '/operador/panel', target: '/api/establishments/est_ux/panel', selector: '.panel-stat', props: ['x', 'y', 'width', 'height'] },
  { path: '/operador/lotes', target: '/api/establishments/est_ux/lots', selector: '.my-lot', props: ['x', 'y', 'width', 'height'] },
]

async function boxes(page, selector) {
  return page.locator(selector).evaluateAll(elements => elements.map(element => {
    const r = element.getBoundingClientRect()
    return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height }
  }))
}

function sameGeometry(before, after, props, label) {
  assert.equal(before.length, after.length, `${label}: cantidad de regiones`)
  before.forEach((rect, index) => props.forEach(prop => {
    assert.ok(Math.abs(rect[prop] - after[index][prop]) <= 2,
      `${label}: región ${index} ${prop} pasó de ${rect[prop]} a ${after[index][prop]}`)
  }))
}

try {
  for (const width of [360, 1366]) {
    for (const screen of screens.filter(screen => !process.env.UX_PATHS || process.env.UX_PATHS.split(',').includes(screen.path))) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true,
        timezoneId: 'Asia/Tokyo', reducedMotion: 'reduce' })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      let release
      const held = new Promise(resolve => { release = resolve })
      let pending = true
      await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname
        if (path === '/api/auth/session') return route.fulfill({ json: { session, csrfToken: 'controlled' } })
        if (path === screen.target && pending) await held
        if (path === '/api/notifications') return route.fulfill({ json: {
          items: [0, 1, 2].map(index => ({ ...(screen.path === '/incidencias' ? incidentNotification : notification), id: `notice_${index}` })), page: 1, hasNextPage: false, unreadCount: 3,
        } })
        assert.ok(fixtures[path], `Ruta sin fixture: ${path}`)
        return route.fulfill({ json: fixtures[path] })
      })
      try {
        await page.goto(base + screen.path)
        await page.locator('main .ui-skeleton').first().waitFor()
        // La sesión se resuelve antes de medir el recurso retenido.
        await page.locator('.session-status').waitFor({ state: 'attached' })
        await page.locator(screen.selector).first().waitFor()
        const before = await boxes(page, screen.selector)
        const imageName = `${width}-${screen.path.replaceAll('/', '_')}`
        if (screenshots) await page.screenshot({ path: `${screenshots}/${imageName}-loading.png`, fullPage: true })
        const focusable = await page.locator('main [aria-hidden="true"]').evaluateAll(elements =>
          elements.flatMap(element => [...element.querySelectorAll('a[href], button, input, select, textarea, [tabindex="0"]')]).length)
        assert.equal(focusable, 0, `${screen.path}: skeleton sin controles enfocables`)
        assert.equal(await page.locator('.ui-skeleton').first().evaluate(el => getComputedStyle(el).animationName), 'none')
        pending = false; release()
        await page.locator('main .ui-skeleton').first().waitFor({ state: 'hidden' })
        sameGeometry(before, await boxes(page, screen.selector), screen.props, `${width} ${screen.path}`)
        if (screenshots) await page.screenshot({ path: `${screenshots}/${imageName}-loaded.png`, fullPage: true })
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${screen.path}: desborde`)
        assert.deepEqual(errors, [], screen.path)
        if (screen.path === '/lotes') {
          assert.match(await page.locator('.lot-meta').first().innerText(), /15\/01\/2030 · 15:05 – 18:00/)
          // La URL se interpreta en Santiago aunque el navegador esté en Tokio.
          await page.goto(base + '/lotes?pickupBefore=2030-01-15T18%3A05%3A00Z')
          assert.equal(await page.locator('input[type="datetime-local"]').inputValue(), '2030-01-15T15:05')
          await page.getByRole('button', { name: 'Buscar lotes', exact: true }).waitFor()
          await page.getByRole('button', { name: 'Buscar lotes', exact: true }).click()
          await page.waitForURL(url => url.searchParams.get('pickupBefore') === '2030-01-15T15:05:00-03:00')
        }
        if (screen.path === '/avisos' || screen.path.endsWith('/chat')) {
          assert.equal(await page.locator('main time').first().innerText(), '15/01/2030 · 15:05')
          assert.match(await page.locator('main').innerText(), /America\/Santiago/)
        }
        if (screen.path === '/incidencias') {
          const cards = await page.locator('.notification--incident').evaluateAll(elements => elements.map(card => {
            const paragraphs = [...card.querySelectorAll('p')]
            return { height: card.getBoundingClientRect().height,
              natural: paragraphs.every(p => getComputedStyle(p).minBlockSize === '0px') }
          }))
          for (const card of cards) {
            assert.ok(card.natural, 'los párrafos de incidencia no reservan líneas vacías')
            assert.ok(card.height < (width === 360 ? 620 : 420), 'aviso corto con altura compacta')
          }
          let listRelease
          const listHeld = new Promise(resolve => { listRelease = resolve })
          await page.route('**/api/notifications?*', async route => {
            await listHeld
            await route.fulfill({ json: { items: [0, 1, 2].map(index => ({ ...incidentNotification, id: `notice_${index}` })), page: 1, hasNextPage: false, unreadCount: 3 } })
          })
          const stable = await boxes(page, '.notification--incident')
          await page.evaluate(() => window.dispatchEvent(new Event('online')))
          await page.locator('[aria-label="Bandeja de avisos"][aria-busy="true"]').waitFor()
          sameGeometry(stable, await boxes(page, '.notification--incident'), ['x', 'y', 'width', 'height'], 'avisos durante refresco')
          listRelease()
          await page.locator('[aria-label="Bandeja de avisos"][aria-busy="false"]').waitFor()
          sameGeometry(stable, await boxes(page, '.notification--incident'), ['x', 'y', 'width', 'height'], 'avisos actualizados')
        }
        if (screen.path === '/incidencias/notice_incident') {
          // Texto de altura natural: no reservar líneas vacías para igualar una respuesta desconocida.
          const compact = await page.locator('.incident-detail__text').evaluateAll(sections => sections.map(section => {
            const heading = section.querySelector('h3').getBoundingClientRect()
            const text = section.querySelector('p').getBoundingClientRect()
            return { gap: text.top - heading.bottom, extra: section.getBoundingClientRect().height - heading.height - text.height }
          }))
          for (const section of compact) {
            assert.ok(section.gap >= 0 && section.gap <= 8, 'título y texto separados por un solo token')
            assert.ok(section.extra <= 8, 'sección sin alturas vacías')
          }
          assert.ok(await page.locator('.incident-detail').evaluate(card => card.getBoundingClientRect().height) < (width === 360 ? 850 : 620),
            'el detalle corto debe mantenerse compacto')
          let refreshRelease
          const refreshHeld = new Promise(resolve => { refreshRelease = resolve })
          await page.route('**/api/notifications/notice_incident', async route => {
            await refreshHeld
            await route.fulfill({ json: incidentNotification })
          })
          const settled = await boxes(page, '.incident-detail__text, .incident-detail__read')
          await page.evaluate(() => window.dispatchEvent(new Event('online')))
          await page.locator('[aria-label="Detalle de incidencia"][aria-busy="true"]').waitFor()
          sameGeometry(settled, await boxes(page, '.incident-detail__text, .incident-detail__read'), ['x', 'y', 'width', 'height'], 'detalle visible durante refresco')
          refreshRelease()
          await page.locator('[aria-label="Detalle de incidencia"][aria-busy="false"]').waitFor()
          sameGeometry(settled, await boxes(page, '.incident-detail__text, .incident-detail__read'), ['x', 'y', 'width', 'height'], 'detalle actualizado')
        }
        if (screen.path === '/operador/panel') assert.match(await page.locator('.panel-period__scope').innerText(), /01\/01\/2030 y el 15\/01\/2030/)
        console.log(`OK ${width}: ${screen.path}, geometría de carga → datos`)
      } catch (error) {
        console.error(screen.path, errors, await page.locator('body').innerText())
        throw error
      } finally { pending = false; release(); await context.close() }
    }
  }

  // Consultar una reserva ya visible conserva los espacios; el código se oculta
  // hasta comprobar vigencia y vuelve a aparecer sin mover el botón inferior.
  const context = await browser.newContext({ viewport: { width: 360, height: 900 }, ignoreHTTPSErrors: true })
  const page = await context.newPage()
  let hold = false, release
  const held = new Promise(resolve => { release = resolve })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/session') return route.fulfill({ json: { session, csrfToken: 'controlled' } })
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], page: 1, hasNextPage: false, unreadCount: 0 } })
    if (path === '/api/reservations/res_ux') { if (hold) await held; return route.fulfill({ json: reservation }) }
    throw new Error(`Ruta inesperada: ${path}`)
  })
  try {
    await page.goto(base + '/reservas/res_ux')
    await page.getByText(reservation.pickupCode, { exact: true }).waitFor()
    const before = await boxes(page, '.reservation-detail__refresh')
    hold = true
    await page.getByRole('button', { name: 'Consultar estado actualizado' }).click()
    await page.locator('.pickup-code .ui-skeleton').waitFor()
    assert.equal(await page.getByText(reservation.pickupCode, { exact: true }).count(), 0)
    sameGeometry(before, await boxes(page, '.reservation-detail__refresh'), ['x', 'y', 'width', 'height'], 'recarga pendiente')
    hold = false; release()
    await page.getByText(reservation.pickupCode, { exact: true }).waitFor()
    sameGeometry(before, await boxes(page, '.reservation-detail__refresh'), ['x', 'y', 'width', 'height'], 'recarga finalizada')
    console.log('OK recarga sin desplazamiento, código oculto mientras se comprueba vigencia')
  } finally { release(); await context.close() }

  const states = await browser.newContext({ viewport: { width: 360, height: 900 }, ignoreHTTPSErrors: true })
  const statePage = await states.newPage()
  let result = 'error'
  await statePage.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/session') return route.fulfill({ json: { session: null, csrfToken: 'controlled' } })
    assert.equal(path, '/api/public/lots')
    if (result === 'error') return route.fulfill({ status: 503, json: {} })
    return route.fulfill({ json: { items: result === 'empty' ? [] : [{ ...lot,
      description: 'Pack de alimentos variados para compartir con toda la familia. '.repeat(8),
      address: 'Dirección con referencias extensas para encontrar el establecimiento. '.repeat(4),
      pickupEndsAt: '2030-01-16T04:00:00Z',
    }], page: 1, hasNextPage: false } })
  })
  try {
    await statePage.goto(base + '/lotes')
    await statePage.getByRole('alert').waitFor()
    assert.equal(await statePage.locator('main .ui-skeleton').count(), 0)
    result = 'empty'
    await statePage.getByRole('button', { name: 'Reintentar', exact: true }).click()
    await statePage.getByRole('heading', { name: 'No se encontraron lotes con estos filtros.' }).waitFor()
    assert.equal(await statePage.locator('main .ui-skeleton').count(), 0)
    result = 'long'
    await statePage.getByRole('button', { name: 'Ver todos los lotes', exact: true }).click()
    await statePage.locator('.lot-card-public h3 a').waitFor()
    for (const width of [360, 1366]) {
      await statePage.setViewportSize({ width, height: 900 })
      assert.equal(await statePage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: texto largo sin desborde`)
      assert.match(await statePage.locator('.lot-meta').innerText(), /16\/01\/2030 · 01:00/)
    }
    console.log('OK error, reintento, vacío y contenido largo sin skeleton permanente ni desborde')
  } finally { await states.close() }
} finally { await browser.close(); await vite?.close() }
