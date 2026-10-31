import assert from 'node:assert/strict'
import { chromium } from './support/browser.mjs'

// Distribución con sesión de operador (cabecera completa) y HTTP controlado.
const base = process.env.WEB_URL ?? 'http://localhost:5173'
const browser = await chromium.launch()
const lot = { id: 'lot_test', description: 'Pack de panes surtidos para compartir', category: 'Panadería', quantity: 10, availableQuantity: 10, conditions: 'Traer bolsa.', address: 'Calle ficticia 123', latitude: -33.45, longitude: -70.66, timeZone: 'America/Santiago', pickupStartsAt: '2030-01-15T18:00:00Z', pickupEndsAt: '2030-01-15T21:00:00Z', photos: [], photoUrl: null, distanceKm: null }
const session = { user: { id: 'usr_layout', email: 'operador.con.correo.largo.para.probar@example.test' }, operableEstablishments: [{ id: 'est_layout', name: 'Almacén ficticio' }], expiresAt: '2030-01-15T22:00:00Z' }
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/session') return route.fulfill({ json: { session, csrfToken: 'controlled' } })
    if (path === '/api/notifications') return route.fulfill({ json: { items: [], page: 1, hasNextPage: false, unreadCount: 0 } })
    if (path === '/api/public/lots') return route.fulfill({ json: { items: [lot, { ...lot, id: 'lot_two' }, { ...lot, id: 'lot_three' }], page: 1, hasNextPage: false } })
    if (path === '/api/public/lots/lot_test') return route.fulfill({ json: lot })
    throw new Error(`Ruta inesperada: ${path}`)
  })
  await page.goto(base + '/lotes')
  await page.locator('.session-status').waitFor({ state: 'attached' })
  await page.locator('.lot-card-public').first().waitFor()
  // Redimensionar la misma página, como DevTools, también en sentido inverso.
  for (const width of [320, 360, 390, 768, 820, 1024, 1280, 1281, 1366, 1920, 820, 360]) {
    await page.setViewportSize({ width, height: 900 })
    const layout = await page.evaluate(() => {
      const header = document.querySelector('.site-header').getBoundingClientRect()
      const cards = [...document.querySelectorAll('.lot-card-public')].map(el => el.getBoundingClientRect())
      return { overflow: document.documentElement.scrollWidth > innerWidth, height: header.height,
        cardWidths: cards.map(rect => rect.width), columns: cards.filter(rect => Math.abs(rect.top - cards[0].top) < 1).length }
    })
    assert.equal(layout.overflow, false, `${width}: desborde horizontal`)
    assert.ok(layout.height <= 80, `${width}: cabecera ocupa varias filas con menú cerrado`)
    assert.equal(layout.columns, width <= 768 ? 1 : width < 936 ? 2 : 3, `${width}: columnas legibles`)
    assert.ok(layout.cardWidths.every(value => value >= Math.min(288, width - 32)), `${width}: tarjetas demasiado estrechas`)
    const menu = page.getByRole('button', { name: 'Abrir menú', exact: true })
    assert.equal(await menu.isVisible(), width <= 1280, `${width}: navegación adaptable`)
    if (width <= 1280) {
      await menu.click()
      const links = page.getByRole('navigation', { name: 'Navegación principal' }).getByRole('link')
      // Explorar, esperas, reservas, avisos, Mi establecimiento, Mis lotes y Publicar lote.
      assert.equal(await links.count(), 7)
      const boxes = await links.evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, height: r.height } }))
      for (let i = 0; i < boxes.length; i++) {
        assert.ok(boxes[i].x >= 0 && boxes[i].right <= width && boxes[i].height >= 44, `${width}: enlace ${i} fuera de pantalla o pequeño: ${JSON.stringify(boxes[i])}`)
        if (i) assert.ok(boxes[i].y >= boxes[i - 1].bottom, `${width}: enlaces superpuestos`)
      }
      await page.keyboard.press('Escape')
    }
  }
  await page.goto(base + '/lotes/lot_test')
  await page.getByLabel('Cantidad de packs (obligatorio)', { exact: true }).waitFor()
  for (const width of [320, 360, 768, 820, 1024, 1280, 1366]) {
    await page.setViewportSize({ width, height: 900 })
    const layout = await page.evaluate(() => {
      const gallery = document.querySelector('.lot-gallery').getBoundingClientRect()
      const panel = document.querySelector('.reservation-panel').getBoundingClientRect()
      const controls = [...document.querySelectorAll('.reserve-quantity > *, .reserve-form > button')].map(el => el.getBoundingClientRect())
      return { overflow: document.documentElement.scrollWidth > innerWidth, panel: { x: panel.x, right: panel.right, width: panel.width, top: panel.top }, gallery: { bottom: gallery.bottom, right: gallery.right }, controls: controls.map(r => ({ x: r.x, right: r.right, width: r.width })) }
    })
    assert.equal(layout.overflow, false, `${width}: desborde del detalle`)
    assert.ok(layout.panel.width >= Math.min(352, width - 32), `${width}: panel comprimido`)
    assert.ok(layout.controls.every(r => r.width > 0 && r.x >= layout.panel.x && r.right <= layout.panel.right), `${width}: controles fuera del panel`)
    if (width <= 1024) assert.ok(layout.panel.top >= layout.gallery.bottom, `${width}: panel debe apilarse bajo la galería`)
    else assert.ok(layout.panel.x >= layout.gallery.right, `${width}: panel junto a la galería`)
  }
  console.log('OK K033 responsive: cabecera, menú, tarjetas y panel de reserva de 320 a 1920 px; redimensionado sin recarga')
} finally { await browser.close() }
