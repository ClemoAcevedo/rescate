import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const browser = await chromium.launch()
const base = process.env.WEB_URL ?? 'http://localhost:5173'
const messages = []
const keys = new Map()
const queries = []
const errors = []
let open = true
let lose = true
let releaseFirst
const firstSend = new Promise(resolve => { releaseFirst = resolve })
try {
  const pages = []
  for (const author of ['holder', 'operator']) {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    await page.clock.install()
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith('/auth/session')) return route.fulfill({ json: { csrfToken: 'csrf', session: { user: { id: author, email: `${author}@example.test` }, operableEstablishments: [], expiresAt: '2030-01-01T00:00:00Z' } } })
      if (url.pathname.endsWith('/notifications')) return route.fulfill({ json: { items: [], page: 1, hasNextPage: false, unreadCount: 0 } })
      assert.equal(url.pathname, '/api/reservations/res_chat/messages')
      if (route.request().method() === 'GET') {
        const after = Number(url.searchParams.get('after'))
        queries.push({ author, after })
        return route.fulfill({ json: { items: messages.filter(m => m.sequence > after).slice(0, 50).map(m => ({ ...m, mine: m.author === author })), hasMore: messages.filter(m => m.sequence > after).length > 50, open } })
      }
      assert.equal(route.request().headers()['x-csrf-token'], 'csrf')
      const body = route.request().postDataJSON()
      let message = keys.get(body.idempotencyKey)
      if (!message) {
        message = { id: `msg_${messages.length}`, sequence: messages.length + 1, text: body.text, author, createdAt: new Date().toISOString() }
        messages.push(message); keys.set(body.idempotencyKey, message)
      }
      if (lose) { await firstSend; lose = false; return route.abort() }
      return route.fulfill({ status: 201, json: { id: message.id, sequence: message.sequence, createdAt: message.createdAt } })
    })
    await page.goto(`${base}/reservas/res_chat/chat`)
    await page.getByRole('textbox', { name: 'Mensaje (obligatorio)', exact: true }).waitFor()
    pages.push(page)
  }
  const [holder, operator] = pages
  await holder.getByRole('textbox', { name: 'Mensaje (obligatorio)', exact: true }).fill('Hola desde titular')
  await holder.getByRole('button', { name: 'Enviar mensaje', exact: true }).click()
  await holder.getByText('Pendiente de confirmación…', { exact: true }).waitFor()
  assert.equal(await holder.getByRole('button', { name: 'Enviar mensaje', exact: true }).isDisabled(), true)
  releaseFirst()
  await holder.getByRole('button', { name: 'Reintentar el mismo mensaje' }).click()
  await holder.locator('.chat__messages li').filter({ hasText: 'Hola desde titular' }).waitFor()
  assert.equal(messages.length, 1)
  await operator.getByRole('button', { name: 'Consultar conversación' }).click()
  await operator.locator('.chat__messages li').filter({ hasText: 'Hola desde titular' }).waitFor()
  await holder.context().setOffline(true)
  await operator.getByRole('textbox', { name: 'Mensaje (obligatorio)', exact: true }).fill('Respuesta del local')
  await operator.getByRole('button', { name: 'Enviar mensaje', exact: true }).click()
  await operator.locator('.chat__messages li').filter({ hasText: 'Respuesta del local' }).waitFor()
  await holder.context().setOffline(false)
  await holder.locator('.chat__messages li').filter({ hasText: 'Respuesta del local' }).waitFor()
  assert.equal(await holder.locator('.chat__messages li').count(), 2)
  // Reconectar drena varias páginas sin adelantar el cursor por un POST.
  await holder.context().setOffline(true)
  for (let i = 0; i < 53; i++) messages.push({ id: `backlog_${i}`, sequence: messages.length + 1,
    author: 'operator', text: `Mensaje recuperado ${i}`, createdAt: new Date().toISOString() })
  await holder.context().setOffline(false)
  await holder.locator('.chat__messages li').filter({ hasText: 'Mensaje recuperado 52' }).waitFor()
  assert.equal(await holder.locator('.chat__messages li').count(), 55)
  assert.ok(queries.some(q => q.author === 'holder' && q.after === 52))
  // El reloj comprueba 5 s y ausencia de consultas con la vista oculta.
  const count = () => queries.filter(q => q.author === 'holder').length
  let before = count()
  const polled = holder.waitForResponse(response => response.url().includes('/messages?after=55'))
  await holder.clock.runFor(5000)
  await polled
  assert.ok(count() > before)
  await holder.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  before = count()
  await holder.clock.runFor(10000)
  assert.equal(count(), before)
  const resumed = holder.waitForResponse(response => response.url().includes('/messages?after=55'))
  await holder.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await resumed
  assert.ok(count() > before)
  open = false
  await holder.getByRole('button', { name: 'Consultar conversación' }).click()
  await holder.getByText(/Conversación cerrada/).waitFor()
  assert.equal(await holder.getByRole('textbox', { name: 'Mensaje (obligatorio)', exact: true }).isDisabled(), true)
  assert.equal(await holder.getByRole('button', { name: 'Enviar mensaje', exact: true }).isDisabled(), true)
  assert.equal(await holder.locator('body').evaluate(el => el.scrollWidth <= window.innerWidth), true)
  await holder.setViewportSize({ width: 1366, height: 768 })
  assert.equal(await holder.locator('body').evaluate(el => el.scrollWidth <= window.innerWidth), true)
  assert.deepEqual(errors, [])
  console.log('Chat: dos contextos, respuesta perdida, reintento sin duplicados, reconexión y cierre OK (HTTP controlado).')
} finally { await browser.close() }
