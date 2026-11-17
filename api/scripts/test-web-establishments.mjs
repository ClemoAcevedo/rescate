import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../web/node_modules/vite/dist/node/index.js'
import { chromium } from './support/browser.mjs'

const root = fileURLToPath(new URL('../../web/', import.meta.url))
const vite = process.env.WEB_URL ? null : await createServer({ root, server: { host: '127.0.0.1', port: 0 } })
await vite?.listen()
const base = (process.env.WEB_URL ?? vite.resolvedUrls.local[0]).replace(/\/$/, '')
const browser = await chromium.launch()
const items = Array.from({ length: 45 }, (_, n) => ({ id: `abcdef00-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
  name: n === 44 ? 'Panadería Última' : `Local ${String(n).padStart(2, '0')}`, address: `Dirección del local ${n}`,
  latitude: -33.45, longitude: -70.66, timeZone: 'America/Santiago' }))
const normalize = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
try {
  for (const width of [360, 1366]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    let releaseDetails
    const detailsWait = new Promise(resolve => { releaseDetails = resolve })
    let failSearch = true, failDetails = true
    const lotRequests = []
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url())
      const path = url.pathname
      if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'controlled', session: {
        user: { id: 'usr_establishments', email: 'operador@example.test' }, expiresAt: '2030-01-01T00:00:00Z',
        operableEstablishments: items.slice(0, 20).map(({ id, name }) => ({ id, name })),
      } } })
      if (path === '/api/notifications') return route.fulfill({ json: { items: [], page: 1, hasNextPage: false, unreadCount: 0 } })
      if (/^\/api\/establishments\/[^/]+\/lots$/.test(path)) {
        lotRequests.push(path)
        return route.fulfill({ json: { items: [], page: 1, hasNextPage: false } })
      }
      if (path === '/api/establishments') {
        const query = url.searchParams.get('query') ?? ''
        const number = Number(url.searchParams.get('page') ?? 1)
        if (query === 'Local' && failSearch) {
          failSearch = false
          return route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Temporal' } } })
        }
        if (query === 'anterior') await new Promise(resolve => setTimeout(resolve, 600))
        const filtered = items.filter(item => normalize(item.name).includes(normalize(query)))
        return route.fulfill({ json: { items: filtered.slice((number - 1) * 20, number * 20), page: number, hasNextPage: filtered.length > number * 20 } })
      }
      const found = items.find(item => path === `/api/establishments/${item.id}`)
      if (found) {
        if (found === items[44]) await detailsWait
        if (found === items[43] && failDetails) {
          failDetails = false
          return route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Temporal' } } })
        }
        return route.fulfill({ json: found })
      }
      throw new Error(`Ruta inesperada: ${path}`)
    })
    await page.goto(base + '/operador/lotes/nuevo')
    const picker = page.getByRole('combobox', { name: /^Establecimiento/ })
    await picker.click()
    await page.getByRole('option').nth(19).waitFor()
    await page.getByRole('button', { name: 'Más resultados', exact: true }).click()
    await page.getByRole('option').nth(39).waitFor()
    await page.getByRole('button', { name: 'Más resultados', exact: true }).click()
    await page.getByRole('option', { name: 'Panadería Última', exact: true }).waitFor()
    assert.equal(await page.getByRole('option').count(), 45)
    await picker.fill('anterior')
    await page.waitForTimeout(300)
    await picker.fill('panaderia ultima')
    await page.getByRole('option', { name: 'Panadería Última', exact: true }).waitFor()
    await page.waitForTimeout(650)
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['Panadería Última'], 'una respuesta vieja no sustituye la búsqueda actual')
    await picker.fill('sin coincidencia')
    await page.getByText('Sin coincidencias.', { exact: true }).waitFor()
    await picker.fill('Local')
    await page.getByRole('button', { name: 'Reintentar búsqueda', exact: true }).click()
    await page.getByRole('option', { name: 'Local 00', exact: true }).waitFor()
    await picker.fill('panaderia ultima')
    await page.getByRole('option', { name: 'Panadería Última', exact: true }).waitFor()
    await picker.press('Enter')
    assert.equal(await page.locator('[name="establishmentId"]').inputValue(), items[44].id)
    await page.locator('[name="description"]').fill('Contenido conservado al cambiar establecimiento')
    await page.locator('[name="address"]').fill('Dirección escrita a mano')
    await page.locator('[name="latitude"]').fill('-1')
    const zone = page.getByRole('combobox', { name: /^Zona horaria/ })
    await zone.fill('lima'); await page.getByRole('option', { name: 'America/Lima', exact: true }).click()
    const positions = async () => page.locator('[name="description"], [name="address"], [name="latitude"], form.lot-form button[type="submit"]').evaluateAll(elements => elements.map(el => {
      const rect = el.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }))
    const before = await positions()
    releaseDetails()
    await page.waitForFunction(() => document.querySelector('[name="longitude"]')?.value === '-70.66')
    assert.equal(await page.locator('[name="address"]').inputValue(), 'Dirección escrita a mano')
    assert.equal(await page.locator('[name="latitude"]').inputValue(), '-1')
    assert.equal(await page.locator('[name="timeZone"]').inputValue(), 'America/Lima')
    const after = await positions()
    for (let n = 0; n < before.length; n++) for (const field of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[n][field] - after[n][field]) <= 1, `${width}: geometría de precarga ${n}.${field}`)
    await picker.fill('Local 43')
    await page.getByRole('option', { name: 'Local 43', exact: true }).click()
    await page.getByText(/Puedes completar la ubicación a mano/).waitFor()
    await page.locator('[name="address"]').fill('Dirección conservada al reintentar')
    await page.getByRole('button', { name: 'Reintentar ubicación', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[name="longitude"]')?.value === '-70.66')
    assert.equal(await page.locator('[name="address"]').inputValue(), 'Dirección conservada al reintentar')
    assert.equal(await page.locator('.lot-form__defaults').evaluate(element => element === document.activeElement), true, 'el reintento devuelve foco a la ubicación sin perderlo en body')
    assert.equal(await page.locator('[name="description"]').inputValue(), 'Contenido conservado al cambiar establecimiento')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.goto(`${base}/operador/lotes?establecimiento=${items[44].id.toUpperCase()}`)
    await page.getByRole('combobox', { name: /^Establecimiento/ }).waitFor()
    await page.waitForFunction(() => document.querySelector('input[role="combobox"]')?.value === 'Panadería Última')
    assert.deepEqual([...new Set(lotRequests)], [`/api/establishments/${items[44].id}/lots`], 'enlace fuera de las veinte iniciales se resuelve antes de consultar lotes, sin elegir otro establecimiento')
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`PASS #97/#99 ${width}px: 45 opciones paginadas, tildes, respuesta obsoleta, vacío, error/reintento, teclado y precarga tardía sin sobrescribir ni desplazar controles`)
  }
} finally { await browser.close(); await vite?.close() }
