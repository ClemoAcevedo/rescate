import assert from 'node:assert/strict'
import { chromium } from './support/browser.mjs'
import { startMockWeb } from './support/mock-web.mjs'
let browser
const messages = []
const keys = new Map()
const queries = []
const errors = []
let open = true
let lose = true
let releaseFirst
const firstSend = new Promise(resolve => { releaseFirst = resolve })
const mock = await startMockWeb(async ({ method, url, headers, body }) => {
  const author = headers.cookie?.includes('mock_actor=operator') ? 'operator' : 'holder'
  if (url.pathname === '/auth/session') return { body: { csrfToken: 'csrf', session: { user: { id: author, email: `${author}@example.test` }, operableEstablishments: [], expiresAt: '2030-01-01T00:00:00Z' } } }
  if (url.pathname === '/notifications') return { body: { items: [], page: 1, hasNextPage: false, unreadCount: 0 } }
  assert.equal(url.pathname, '/reservations/res_chat/messages')
  if (method === 'GET') {
    const after = Number(url.searchParams.get('after'))
    queries.push({ author, after })
    return { body: { items: messages.filter(m => m.sequence > after).slice(0, 50).map(m => ({ ...m, mine: m.author === author })), hasMore: messages.filter(m => m.sequence > after).length > 50, open } }
  }
  assert.equal(method, 'POST')
  assert.equal(headers['x-csrf-token'], 'csrf')
  let message = keys.get(`${author}:${body.idempotencyKey}`)
  if (!message) {
    message = { id: `msg_${messages.length}`, sequence: messages.length + 1, text: body.text, author, createdAt: new Date().toISOString() }
    messages.push(message); keys.set(`${author}:${body.idempotencyKey}`, message)
  }
  const result = { status: 201, body: { id: message.id, sequence: message.sequence, createdAt: message.createdAt } }
  if (lose) { lose = false; return { ...result, wait: firstSend, disconnect: true } }
  return result
})
const base = mock.url
try {
  browser = await chromium.launch()
  const pages = []
  for (const author of ['holder', 'operator']) {
    // El runner HTTPS usa un certificado local autofirmado, igual que los demás recorridos.
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 800 } })
    await context.addCookies([{ name: 'mock_actor', value: author, url: base }])
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    await page.clock.install()
    page.on('pageerror', error => errors.push(error.message))
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
  // El día 27 junto al mensaje 5 reproduce la coincidencia parcial con «52» del selector anterior.
  for (let i = 0; i < 53; i++) messages.push({ id: `backlog_${i}`, sequence: messages.length + 1,
    author: 'operator', text: `Mensaje recuperado ${i}`, createdAt: '2026-10-27T11:52:34Z' })
  await holder.context().setOffline(false)
  await holder.locator('.chat__messages').getByText('Mensaje recuperado 52', { exact: true }).waitFor()
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
  assert.deepEqual(mock.failures, [])
  assert.ok(mock.requests.some(r => r.method === 'POST'))
  console.log('Chat: dos contextos, respuesta perdida, reintento sin duplicados, reconexión y cierre OK (servidor mock HTTP validado contra OpenAPI).')
} finally {
  releaseFirst()
  try { await browser?.close() } finally { await mock.close() }
}
