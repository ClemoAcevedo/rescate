// K022 · Reglas de cancelación, retiro y vencimiento; código cifrado; recorrido HTTP
// con repositorio en memoria. PostgreSQL real se prueba en scripts/test-reservations.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  canConfirmPickup, currentStatus, decideCancellation, endedAt, normalizePickupCode, requirePickup,
  PICKUP_CODE_ALPHABET, ReservationTransitionError,
} from '../src/domain/reservations.js'
import type { ReservationStatus } from '../src/domain/reservations.js'
import { createPickupCodes } from '../src/infrastructure/crypto/pickup-codes.js'
import { createReservationUseCases } from '../src/application/reservations/use-cases.js'
import type { ReservationRepository } from '../src/application/reservations/ports.js'
import { createReservationsRouter } from '../src/http/reservations-router.js'
import { createApp } from '../src/app.js'
import { readPickupCodeKey } from '../src/composition.js'
import { assertContract } from './support/openapi.js'

const starts = new Date('2030-01-15T18:00:00Z')
const ends = new Date('2030-01-15T21:00:00Z')
const window = { pickupStartsAt: starts, pickupEndsAt: ends }
const before = new Date(starts.getTime() - 1)
const during = new Date(starts.getTime() + 1)

test('una confirmada vence en el instante de cierre aunque no esté registrada', () => {
  assert.equal(currentStatus('confirmed', ends, new Date(ends.getTime() - 1)), 'confirmed')
  assert.equal(currentStatus('confirmed', ends, ends), 'expired')
  assert.equal(currentStatus('cancelled', ends, ends), 'cancelled')
  assert.equal(endedAt('confirmed', null, ends, ends)?.getTime(), ends.getTime())
  assert.equal(endedAt('confirmed', null, ends, during), null)
})

test('cancelar: solo una confirmada vigente; repetir no libera otra vez', () => {
  assert.equal(decideCancellation({ status: 'confirmed' }, window, during), 'cancel')
  assert.equal(decideCancellation({ status: 'confirmed' }, window, before), 'cancel')
  assert.equal(decideCancellation({ status: 'cancelled' }, window, during), 'already_cancelled')
  for (const [status, at, reason] of [['delivered', during, 'delivered'], ['expired', during, 'expired'],
    ['confirmed', ends, 'expired']] as const) {
    assert.throws(() => decideCancellation({ status }, window, at), { reason })
  }
})

test('retirar: confirmada dentro de [inicio, cierre); terminales y antes del inicio se rechazan', () => {
  requirePickup({ status: 'confirmed' }, window, starts)
  assert.equal(canConfirmPickup({ status: 'confirmed' }, window, starts), true)
  assert.throws(() => requirePickup({ status: 'confirmed' }, window, before), { reason: 'pickup_not_started' })
  assert.equal(canConfirmPickup({ status: 'confirmed' }, window, before), false)
  assert.throws(() => requirePickup({ status: 'confirmed' }, window, ends), { reason: 'expired' })
  for (const status of ['cancelled', 'delivered', 'expired'] as const) {
    assert.throws(() => requirePickup({ status }, window, during), ReservationTransitionError)
    assert.equal(canConfirmPickup({ status }, window, during), false)
  }
})

test('el código ingresado se normaliza sin ambigüedad de lectura', () => {
  assert.equal(normalizePickupCode('7kq2-m9xa'), '7KQ2M9XA')
  assert.equal(normalizePickupCode(' 7KQ2 M9XA '), '7KQ2M9XA')
  assert.equal(normalizePickupCode('OIL0ABCD'), '0110ABCD')
  for (const invalid of ['7KQ2M9X', '7KQ2M9XAA', '7KQ2M9XU', '7KQ2M9X!', '']) assert.equal(normalizePickupCode(invalid), null)
})

test('código: ocho símbolos aleatorios, cifrado autenticado y huella por clave', () => {
  const key = randomBytes(32)
  const codes = createPickupCodes(key)
  const issued = Array.from({ length: 2000 }, () => codes.issue())
  for (const { code, ciphertext, fingerprint } of issued.slice(0, 50)) {
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{8}$/)
    assert.equal(codes.reveal(ciphertext), code)
    assert.deepEqual(codes.fingerprint(code), fingerprint)
    assert.equal(Buffer.from(ciphertext).includes(code), false)
  }
  assert.equal(new Set(issued.map(item => item.code)).size, issued.length)
  assert.equal(new Set(issued.flatMap(item => [...item.code])).size, PICKUP_CODE_ALPHABET.length)
  const other = createPickupCodes(randomBytes(32))
  assert.notDeepEqual(other.fingerprint(issued[0]!.code), issued[0]!.fingerprint)
  assert.throws(() => other.reveal(issued[0]!.ciphertext))
  const tampered = Buffer.from(issued[0]!.ciphertext); tampered[tampered.length - 1]! ^= 1
  assert.throws(() => codes.reveal(tampered))
  // Mismo código, otro cifrado: el texto cifrado no revela repeticiones.
  assert.notDeepEqual(createPickupCodes(key).issue().ciphertext, issued[0]!.ciphertext)
})

test('PICKUP_CODE_KEY exige 32 bytes en base64 canónico y rechaza la clave de Compose en producción', () => {
  const key = randomBytes(32).toString('base64')
  assert.equal(readPickupCodeKey({ PICKUP_CODE_KEY: key }).length, 32)
  for (const invalid of [undefined, '', randomBytes(16).toString('base64'), key.replace(/=*$/, '')]) {
    assert.throws(() => readPickupCodeKey({ PICKUP_CODE_KEY: invalid }))
  }
  const compose = 'cmVzY2F0ZS1kZXYtb25seS1waWNrdXAtY29kZS1rZXk='
  assert.equal(readPickupCodeKey({ PICKUP_CODE_KEY: compose }).length, 32)
  assert.throws(() => readPickupCodeKey({ NODE_ENV: 'production', PICKUP_CODE_KEY: compose }), /ficticia/)
})

// Repositorio en memoria con la misma forma que PostgreSQL; el reloj de "la base" es `dbNow`.
function memory(codes: ReturnType<typeof createPickupCodes>) {
  const lot = { id: randomUUID(), description: 'Pack ficticio', conditions: null, address: 'Dirección ficticia 123',
    latitude: -33.45, longitude: -70.66, timeZone: 'America/Santiago', ...window }
  const members = new Set(['operator'])
  const state = { dbNow: during, R: 0, E: 0, X: 0, F: 10 }
  interface Row { id: string; userId: string; quantity: number; status: ReservationStatus; createdAt: Date
    endedAt: Date | null; ciphertext: Uint8Array | null; fingerprint: Uint8Array | null }
  const rows: Row[] = []
  const deliveries: { reservationId: string; operator: string; key: string; quantity: number; deliveredAt: Date }[] = []
  const same = (a: Uint8Array | null, b: Uint8Array | null) => a !== null && b !== null && Buffer.from(a).equals(Buffer.from(b))
  const stored = (row: Row) => ({ id: row.id, quantity: row.quantity, status: row.status, createdAt: row.createdAt,
    endedAt: row.endedAt, lot, codeCiphertext: row.ciphertext })
  const end = (row: Row, status: ReservationStatus, at: Date) => {
    assert.equal(row.status, 'confirmed'); row.status = status; row.endedAt = at; row.ciphertext = null
  }
  function reserve(userId: string, quantity: number, withCode = true) {
    const issued = codes.issue()
    rows.push({ id: randomUUID(), userId, quantity, status: 'confirmed', createdAt: before, endedAt: null,
      ciphertext: withCode ? issued.ciphertext : null, fingerprint: withCode ? issued.fingerprint : null })
    state.F -= quantity; state.R += quantity
    return { id: rows.at(-1)!.id, code: issued.code }
  }
  const repository: ReservationRepository = {
    async listByHolder(userId) { return { items: rows.filter(row => row.userId === userId).map(stored), hasNextPage: false } },
    async findByHolder(userId, id) { const row = rows.find(r => r.userId === userId && r.id === id); return row ? stored(row) : null },
    async withHolderTransaction(userId, id, operate) {
      const row = rows.find(r => r.userId === userId && r.id === id)
      return operate(row ? { reservation: stored(row), now: state.dbNow } : null, {
        async cancel(at) { end(row!, 'cancelled', at); state.R -= row!.quantity; state.F += row!.quantity },
        async assignCode(code) { row!.ciphertext = code.ciphertext; row!.fingerprint = code.fingerprint },
      })
    },
    async findPickup(userId, lotId, fingerprint) {
      if (lotId !== lot.id) return null
      const row = rows.find(r => same(r.fingerprint, fingerprint))
      return { member: members.has(userId), lot: window, reservation: row ? stored(row) : null }
    },
    async withPickupTransaction(operator, lotId, reservationId, fingerprint, key, operate) {
      const prior = deliveries.find(d => d.operator === operator && d.key === key)
      const unavailable = { deliver: async () => assert.fail('No entregar') }
      if (prior) {
        const row = rows.find(r => r.id === prior.reservationId)!
        return operate({ member: members.has(operator), existing: { ...prior, lotId: lot.id,
          codeMatches: same(row.fingerprint, fingerprint) } }, unavailable)
      }
      if (lotId !== lot.id) return operate({ existing: null, lot: null }, unavailable)
      const row = rows.find(r => r.id === reservationId && same(r.fingerprint, fingerprint))
      return operate({ existing: null, lot: window, member: members.has(operator), now: state.dbNow,
        reservation: row ? { status: row.status, quantity: row.quantity } : null }, {
        async deliver(at) {
          end(row!, 'delivered', at); state.R -= row!.quantity; state.E += row!.quantity
          const delivery = { reservationId, operator, key, quantity: row!.quantity, deliveredAt: at }
          deliveries.push(delivery)
          return { reservationId, quantity: delivery.quantity, deliveredAt: at }
        },
      })
    },
    async listExpirable() { return rows.some(r => r.status === 'confirmed') && state.dbNow >= ends ? [lot.id] : [] },
    async withExpiryTransaction(lotId, operate) {
      return operate(lotId === lot.id ? { pickupEndsAt: ends, now: state.dbNow } : null, {
        async expireConfirmed(at) {
          const confirmed = rows.filter(r => r.status === 'confirmed')
          for (const row of confirmed) { end(row, 'expired', at); state.R -= row.quantity; state.X += row.quantity }
          return confirmed.length
        },
      })
    },
  }
  return { lot, members, state, rows, deliveries, reserve, repository }
}

async function harness() {
  const codes = createPickupCodes(randomBytes(32))
  const db = memory(codes)
  // Las lecturas usan el reloj del proceso; los comandos, el de "la base".
  const processNow = { at: during }
  const cases = createReservationUseCases(db.repository, codes, () => processNow.at)
  const app = createApp({ reservationsRouter: createReservationsRouter(cases,
    async request => { const user = request.header('x-test-actor'); return user ? { userId: user } : null },
    async () => {}, () => {}) })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  async function call(actor: string | null, method: string, path: string, body?: unknown) {
    const response = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(actor ? { 'x-test-actor': actor } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) } })
    const result = response.status === 204 ? undefined : await response.json()
    assertContract(method, path, response, result)
    return { status: response.status, body: result }
  }
  return { db, codes, cases, processNow, call, close: () => new Promise(resolve => server.close(resolve)) }
}

test('HTTP: el titular ve su código solo mientras está confirmada; cancelar lo invalida una vez', async () => {
  const h = await harness()
  try {
    const mine = h.db.reserve('holder', 2)
    assert.equal((await h.call(null, 'GET', `/reservations/${mine.id}`)).status, 401)
    assert.equal((await h.call('other', 'GET', `/reservations/${mine.id}`)).status, 404)
    assert.equal((await h.call('other', 'POST', `/reservations/${mine.id}/cancel`, {})).status, 404)
    const detail = await h.call('holder', 'GET', `/reservations/${mine.id.toUpperCase()}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.pickupCode, mine.code)
    assert.equal(detail.body.status, 'confirmed')
    const list = await h.call('holder', 'GET', '/reservations')
    assert.equal(list.body.items.length, 1); assert.equal('pickupCode' in list.body.items[0], false)
    assert.equal((await h.call('holder', 'GET', '/reservations?page=0')).status, 422)
    assert.equal((await h.call('holder', 'POST', `/reservations/${mine.id}/cancel`, { reason: 'x' })).status, 422)

    const cancelled = await h.call('holder', 'POST', `/reservations/${mine.id}/cancel`, {})
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.body.status, 'cancelled'); assert.equal(cancelled.body.pickupCode, null)
    assert.equal(cancelled.body.endedAt, during.toISOString())
    assert.deepEqual([h.db.state.F, h.db.state.R], [10, 0])
    assert.equal(h.db.rows[0]!.ciphertext, null)
    const again = await h.call('holder', 'POST', `/reservations/${mine.id}/cancel`, {})
    assert.deepEqual(again.body, cancelled.body)
    assert.deepEqual([h.db.state.F, h.db.state.R], [10, 0])
    assert.equal((await h.call('holder', 'GET', `/reservations/${mine.id}`)).body.pickupCode, null)

    // La captura del código cancelado se rechaza y una nueva reserva obtiene otro.
    const review = await h.call('operator', 'POST', `/lots/${h.db.lot.id}/pickup-reviews`, { code: mine.code })
    assert.equal(review.body.reservation.status, 'cancelled'); assert.equal(review.body.canConfirm, false)
    assert.equal((await h.call('operator', 'POST', `/lots/${h.db.lot.id}/pickups`,
      { reservationId: mine.id, code: mine.code, idempotencyKey: randomUUID() })).status, 409)
    const next = h.db.reserve('holder', 1)
    assert.notEqual(next.code, mine.code)
    assert.equal((await h.call('holder', 'GET', `/reservations/${next.id}`)).body.pickupCode, next.code)
  } finally { await h.close() }
})

test('HTTP: revisar no consume; confirmar valida de nuevo, entrega una vez y reproduce la clave', async () => {
  const h = await harness()
  try {
    const { id, code } = h.db.reserve('holder', 3)
    const lotPath = `/lots/${h.db.lot.id}`
    assert.equal((await h.call('stranger', 'POST', `${lotPath}/pickup-reviews`, { code })).status, 403)
    assert.equal((await h.call('operator', 'POST', `/lots/${randomUUID()}/pickup-reviews`, { code })).status, 404)
    for (const wrong of ['ZZZZZZZZ', 'corto', '7KQ2M9XU']) {
      assert.equal((await h.call('operator', 'POST', `${lotPath}/pickup-reviews`, { code: wrong })).status, 404)
    }
    assert.equal((await h.call('operator', 'POST', `${lotPath}/pickup-reviews`, { code: 'x'.repeat(33) })).status, 422)
    const review = await h.call('operator', 'POST', `${lotPath}/pickup-reviews`, { code: code.toLowerCase().replace(/(.{4})/, '$1-') })
    assert.deepEqual([review.status, review.body.reservation.id, review.body.canConfirm], [200, id, true])
    assert.equal(h.db.rows[0]!.status, 'confirmed')

    const key = randomUUID()
    const body = { reservationId: id, code, idempotencyKey: key }
    assert.equal((await h.call('stranger', 'POST', `${lotPath}/pickups`, body)).status, 403)
    assert.equal((await h.call('operator', 'POST', `${lotPath}/pickups`, { ...body, code: 'ZZZZZZZZ' })).status, 404)
    assert.equal((await h.call('operator', 'POST', `${lotPath}/pickups`, { ...body, reservationId: 'r' })).status, 422)
    h.db.state.dbNow = before
    assert.equal((await h.call('operator', 'POST', `${lotPath}/pickups`, body)).status, 409)
    h.db.state.dbNow = during
    const delivered = await h.call('operator', 'POST', `${lotPath}/pickups`, body)
    assert.deepEqual(delivered.body, { reservationId: id, quantity: 3, deliveredAt: during.toISOString() })
    assert.deepEqual([h.db.state.R, h.db.state.E, h.db.deliveries.length], [0, 3, 1])
    assert.deepEqual((await h.call('operator', 'POST', `${lotPath}/pickups`, body)).body, delivered.body)
    assert.equal((await h.call('operator', 'POST', `${lotPath}/pickups`, { ...body, code: 'ZZZZZZZZ' })).status, 409)
    assert.equal((await h.call('operator', 'POST', `${lotPath}/pickups`, { ...body, idempotencyKey: randomUUID() })).status, 409)
    assert.equal((await h.call('holder', 'POST', `/reservations/${id}/cancel`, {})).status, 409)
    assert.deepEqual([h.db.state.R, h.db.state.E, h.db.deliveries.length], [0, 3, 1])
    assert.equal((await h.call('operator', 'POST', `${lotPath}/pickup-reviews`, { code })).body.reservation.status, 'delivered')
  } finally { await h.close() }
})

test('vencimiento: la API rechaza al cierre sin trabajador; registrarlo mueve R → X una sola vez', async () => {
  const h = await harness()
  try {
    const { id, code } = h.db.reserve('holder', 2)
    h.db.state.dbNow = ends; h.processNow.at = ends
    const detail = await h.call('holder', 'GET', `/reservations/${id}`)
    assert.deepEqual([detail.body.status, detail.body.pickupCode, detail.body.endedAt], ['expired', null, ends.toISOString()])
    assert.equal((await h.call('holder', 'POST', `/reservations/${id}/cancel`, {})).status, 409)
    assert.equal((await h.call('operator', 'POST', `/lots/${h.db.lot.id}/pickups`,
      { reservationId: id, code, idempotencyKey: randomUUID() })).status, 409)
    assert.equal(h.db.rows[0]!.status, 'confirmed')
    // El registro usa el cierre como instante de término, aunque se procese después.
    h.db.state.dbNow = new Date(ends.getTime() + 60_000)
    assert.equal(await h.cases.expireDue(), 1)
    assert.equal(await h.cases.expireDue(), 0)
    assert.equal(await h.cases.expireLot(h.db.lot.id), 0)
    assert.deepEqual([h.db.state.R, h.db.state.X, h.db.rows[0]!.endedAt], [0, 2, ends])
  } finally { await h.close() }
})

test('una reserva confirmada sin código recibe uno al consultarla; antes del cierre no se vence', async () => {
  const h = await harness()
  try {
    const legacy = h.db.reserve('holder', 1, false)
    const first = await h.call('holder', 'GET', `/reservations/${legacy.id}`)
    assert.match(first.body.pickupCode, /^[0-9A-HJKMNP-TV-Z]{8}$/)
    assert.equal((await h.call('holder', 'GET', `/reservations/${legacy.id}`)).body.pickupCode, first.body.pickupCode)
    assert.equal(await h.cases.expireLot(h.db.lot.id), 0)
    assert.equal(h.db.rows[0]!.status, 'confirmed')
  } finally { await h.close() }
})
