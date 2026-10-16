// K030 · Reglas del outbox, procesamiento por tandas y transporte HTTP de la bandeja.
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/app.js'
import { notAuthorized } from '../src/application/errors.js'
import { createNotificationUseCases, createOutboxProcessor } from '../src/application/notifications/use-cases.js'
import type { ClaimedEvent, NotificationRepository, OutboxRepository, StoredNotification } from '../src/application/notifications/ports.js'
import { OUTBOX_BATCH_SIZE, OUTBOX_MAX_ATTEMPTS, nextAttempt, retryDelayMs } from '../src/domain/notifications.js'
import { createNotificationsRouter } from '../src/http/notifications-router.js'
import { assertContract } from './support/openapi.js'

const at = new Date('2030-01-15T12:00:00Z')
const payload = { lot: { id: '11111111-1111-4111-8111-111111111111', description: 'Pan del día' }, quantity: 4,
  waitlistEntryId: '22222222-2222-4222-8222-222222222222', reservationId: null, offerExpiresAt: '2030-01-15T12:10:00.000Z' }
const event = (id: string, attempts = 1): ClaimedEvent =>
  ({ id, kind: 'offer_issued', recipientUserId: '7', payload, createdAt: at, attempts })

test('reintentos: espera creciente con tope y variación, y fallo visible al agotar intentos', () => {
  assert.equal(retryDelayMs(1, 0.5), 2_000)
  assert.equal(retryDelayMs(2, 0.5), 4_000)
  assert.equal(retryDelayMs(30, 0.5), 300_000)
  assert.equal(retryDelayMs(1, 0), 1_600)
  assert.equal(retryDelayMs(1, 0.999999), 2_400)
  assert.deepEqual(nextAttempt(1, at, 0.5), { retryAt: new Date(at.getTime() + 2_000) })
  assert.deepEqual(nextAttempt(OUTBOX_MAX_ATTEMPTS, at, 0.5), { failed: true })
})

test('el worker reclama tandas de hasta 50 con reclamo vencible y libera los fallos sin perderlos', async () => {
  const calls: string[] = []
  const outbox: OutboxRepository = {
    async claim(limit, claimAt, claimedUntil) {
      assert.equal(limit, OUTBOX_BATCH_SIZE)
      assert.equal(claimedUntil.getTime() - claimAt.getTime(), 120_000)
      return [event('1'), event('2', 2), event('3', OUTBOX_MAX_ATTEMPTS)]
    },
    async deliver(claimed) {
      calls.push(`deliver ${claimed.id}`)
      if (claimed.id !== '1') throw Object.assign(new Error('sin conexión'), { code: '08006' })
    },
    async release(id, retryAt, code) { calls.push(`release ${id} ${retryAt ? retryAt.toISOString() : 'failed'} ${code}`) },
  }
  const logged: Record<string, unknown>[] = []
  const processed = await createOutboxProcessor(outbox, () => at, () => 0.5, entry => logged.push(entry)).processNext()
  assert.equal(processed, 3)
  assert.deepEqual(calls, [
    'deliver 1',
    'deliver 2', `release 2 ${new Date(at.getTime() + 4_000).toISOString()} 08006`,
    'deliver 3', 'release 3 failed 08006',
  ])
  assert.deepEqual(logged.map(entry => [entry.outboxEventId, entry.final]), [['2', false], ['3', true]])
  assert.ok(!JSON.stringify(logged).includes('Pan del día'), 'el registro no incluye datos del aviso')
})

test('leer un aviso ajeno o inexistente responde no encontrado; leer no hace nada más', async () => {
  const stored: StoredNotification = { id: '33333333-3333-4333-8333-333333333333', kind: 'offer_expired', payload,
    createdAt: at, readAt: at }
  const repository: NotificationRepository = {
    listByUser: async () => assert.fail('no listar'),
    markRead: async (userId, id) => (userId === '7' && id === stored.id ? stored : null),
  }
  const cases = createNotificationUseCases(repository, () => at)
  assert.equal(await cases.markRead({ userId: '7' }, stored.id.toUpperCase()), stored)
  await assert.rejects(cases.markRead({ userId: '8' }, stored.id), { code: 'notification_not_found' })
})

async function start(overrides: Partial<ReturnType<typeof createNotificationUseCases>>, actor: string | null = '7') {
  const cases = { list: async () => assert.fail('no esperado'), markRead: async () => assert.fail('no esperado'), ...overrides }
  const app = createApp({ notificationsRouter: createNotificationsRouter(cases as ReturnType<typeof createNotificationUseCases>,
    async () => (actor ? { userId: actor } : null),
    async (request) => { if (request.header('x-test-csrf') !== 'ok') throw notAuthorized() }, () => {}) })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    async call(method: string, path: string, body?: unknown, csrf = 'ok') {
      const response = await fetch(base + path, { method, headers: { 'x-test-csrf': csrf,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
      const json = await response.json()
      assertContract(method, path, response, json)
      return { status: response.status, body: json }
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

test('HTTP: bandeja paginada con contador sin leer, lectura con CSRF y errores según contrato', async () => {
  const notification: StoredNotification = { id: '33333333-3333-4333-8333-333333333333', kind: 'offer_issued', payload,
    createdAt: at, readAt: null }
  let page = 0
  const api = await start({
    list: async (_actor, requested) => { page = requested; return { items: [notification], hasNextPage: false, unreadCount: 1, page: requested } },
    markRead: async () => ({ ...notification, readAt: at }),
  })
  try {
    const listed = await api.call('GET', '/notifications?page=2')
    assert.equal(listed.status, 200)
    assert.equal(page, 2)
    assert.equal(listed.body.unreadCount, 1)
    assert.equal(listed.body.items[0].offerExpiresAt, payload.offerExpiresAt)
    assert.equal((await api.call('GET', '/notifications?page=0')).status, 422)
    assert.equal((await api.call('GET', '/notifications?extra=1')).status, 422)

    const read = await api.call('POST', `/notifications/${notification.id}/read`, {})
    assert.equal(read.status, 200)
    assert.equal(read.body.readAt, at.toISOString())
    assert.equal((await api.call('POST', `/notifications/${notification.id}/read`, {}, 'malo')).status, 403)
    assert.equal((await api.call('POST', `/notifications/${notification.id}/read`, { extra: true })).status, 422)
  } finally { await api.close() }

  const anonymous = await start({}, null)
  try {
    assert.equal((await anonymous.call('GET', '/notifications')).status, 401)
  } finally { await anonymous.close() }
})
