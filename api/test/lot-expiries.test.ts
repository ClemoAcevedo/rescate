// K028 · Política de vencimientos en Application con un repositorio falso: concesión,
// reintentos acotados y registro único. PostgreSQL real y procesos del worker se
// prueban en scripts/test-expiries.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isDueToExpire } from '../src/domain/lots.js'
import { createExpiryUseCases, EXPIRY_LIMITS } from '../src/application/expiries/use-cases.js'
import type { ExpiryState, LotExpiryRepository } from '../src/application/expiries/ports.js'
import { createWorker } from '../src/composition.js'

const ends = new Date('2030-01-15T21:00:00Z')
const lotId = '0b7c3a52-4f7e-4d1e-9b8a-2f3c4d5e6f70'
const after = new Date(ends.getTime() + 90_000)

function fake(options: { failures?: number; state?: Partial<ExpiryState> } = {}) {
  const calls = { claims: [] as [number, number][], releases: [] as [string, number, number | null][],
    settled: 0, expired: [] as Date[], closed: [] as Date[], completed: 0, locked: [] as string[] }
  let attempts = 0
  let failures = options.failures ?? 0
  const state: ExpiryState = { status: 'published', pickupEndsAt: ends, now: after, ...options.state }
  const repository: LotExpiryRepository = {
    async claimNext(leaseMs, maxAttempts) {
      calls.claims.push([leaseMs, maxAttempts])
      return attempts < maxAttempts && state.status === 'published' ? { lotId: lotId.toUpperCase(), attempts: ++attempts } : null
    },
    async withExpiryTransaction(id, operate) {
      calls.locked.push(id)
      if (failures > 0) { failures--; throw Object.assign(new Error('lock timeout en SQL con datos'), { code: '55P03' }) }
      return operate({ ...state }, {
        async settleQueue() { calls.settled++; return 2 },
        async expireReservations(at) { calls.expired.push(at); return 3 },
        async closeLot(at) { calls.closed.push(at); state.status = 'expired' },
        async complete() { calls.completed++; attempts = 0 },
      })
    },
    async release(id, claimed, retryAfterMs) { calls.releases.push([id, claimed, retryAfterMs]) },
  }
  return { repository, calls }
}

test('un lote publicado vence en el instante exacto del cierre; borrador o cerrado no', () => {
  assert.equal(isDueToExpire({ status: 'published', pickupEndsAt: ends }, new Date(ends.getTime() - 1)), false)
  assert.equal(isDueToExpire({ status: 'published', pickupEndsAt: ends }, ends), true)
  for (const status of ['draft', 'expired', 'withdrawn'] as const) assert.equal(isDueToExpire({ status, pickupEndsAt: ends }, after), false)
})

test('registrar el cierre asienta la cola, vence reservas y lote con el instante del cierre, una vez', async () => {
  const { repository, calls } = fake()
  const events: Record<string, unknown>[] = []
  const expiries = createExpiryUseCases(repository, event => events.push(event))
  assert.equal(await expiries.expireNext(), true)
  assert.deepEqual(calls.claims[0], [EXPIRY_LIMITS.leaseMs, EXPIRY_LIMITS.maxAttempts])
  assert.equal(calls.locked[0], lotId)
  assert.deepEqual([calls.settled, calls.expired, calls.closed, calls.completed], [1, [ends], [ends], 1])
  assert.deepEqual(events, [{ event: 'lot_expiry', lotId: lotId.toUpperCase(), attempts: 1,
    lotClosed: true, expiredReservations: 3, closedEntries: 2 }])
  assert.equal(await expiries.expireNext(), false)
  assert.deepEqual(await expiries.expireLot(lotId), { lotClosed: false, expiredReservations: 0, closedEntries: 2 })
  assert.equal(calls.closed.length, 1)
})

test('un lote abierto solo asienta su cola; sin lote no se escribe nada', async () => {
  const { repository, calls } = fake({ state: { now: new Date(ends.getTime() - 1) } })
  assert.deepEqual(await createExpiryUseCases(repository, () => {}).expireLot(lotId),
    { lotClosed: false, expiredReservations: 0, closedEntries: 2 })
  assert.deepEqual([calls.settled, calls.expired, calls.closed, calls.completed], [1, [], [], 1])
  const missing: LotExpiryRepository = { ...fake().repository, withExpiryTransaction: (_id, operate) =>
    operate(null, { settleQueue: assert.fail, expireReservations: assert.fail, closeLot: assert.fail, complete: assert.fail }) }
  assert.deepEqual(await createExpiryUseCases(missing, () => {}).expireLot(lotId),
    { lotClosed: false, expiredReservations: 0, closedEntries: 0 })
})

test('un fallo pospone el lote cada vez más y al agotar los intentos lo deja para revisión', async () => {
  const limits = { leaseMs: 1000, maxAttempts: 3, retryDelayMs: 10 }
  const { repository, calls } = fake({ failures: 5 })
  const events: Record<string, unknown>[] = []
  const expiries = createExpiryUseCases(repository, event => events.push(event), limits)
  for (let i = 0; i < 3; i++) assert.equal(await expiries.expireNext(), true)
  assert.equal(await expiries.expireNext(), false, 'sin intentos no se vuelve a reclamar')
  const id = lotId.toUpperCase()
  assert.deepEqual(calls.releases, [[id, 1, 10], [id, 2, 20], [id, 3, null]])
  assert.deepEqual(events.map(event => [event.event, event.attempts, event.code]),
    [['lot_expiry_retry', 1, '55P03'], ['lot_expiry_retry', 2, '55P03'], ['lot_expiry_exhausted', 3, '55P03']])
  assert.doesNotMatch(JSON.stringify(events), /SQL|datos/)
  assert.deepEqual([calls.closed, calls.completed], [[], 0])
})

test('un reintento que funciona registra el cierre una sola vez', async () => {
  const { repository, calls } = fake({ failures: 1 })
  const expiries = createExpiryUseCases(repository, () => {})
  assert.equal(await expiries.expireNext(), true)
  assert.equal(await expiries.expireNext(), true)
  assert.equal(await expiries.expireNext(), false)
  assert.equal(calls.closed.length, 1)
})

test('worker: vencimientos y avisos activos con base; sin base queda inactivo', async () => {
  const database = 'postgresql://127.0.0.1:1/x'
  assert.equal(createWorker({}), null)
  assert.throws(() => createWorker({ DATABASE_URL: database, WORKER_EXPIRIES: 'no' }), /on u off/)
  // Con los vencimientos apagados, la base sigue alimentando los avisos internos (K030).
  const withoutExpiries = createWorker({ DATABASE_URL: database, WORKER_EXPIRIES: 'off' })
  assert.deepEqual(withoutExpiries?.tasks, ['avisos internos', 'retención del chat'])
  withoutExpiries!.stop()
  await withoutExpiries!.run()
  const worker = createWorker({ DATABASE_URL: database })
  assert.deepEqual(worker?.tasks, ['vencimientos', 'avisos internos', 'retención del chat'])
  worker!.stop()
  await worker!.run()
})
