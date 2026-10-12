// K027 · Reglas puras de la cola FIFO y las ofertas (RF07, ADR 0002). PostgreSQL real,
// HTTP y concurrencia se prueban en scripts/test-waitlist.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  currentWaitlistStatus, decideAcceptance, decideDecline, decideLeave, isAssignable, offerExpiry, planOffers,
  requireWaitlistEntry, waitlistEndedAt, OFFER_DURATION_MS,
} from '../src/domain/waitlist.js'
import type { WaitlistStatus } from '../src/domain/waitlist.js'
import { requireDirectReservation, ReservationRuleError } from '../src/domain/reservations.js'

const now = new Date('2030-01-15T18:00:00Z')
const ends = new Date('2030-01-15T21:00:00Z')
const plus = (ms: number) => new Date(now.getTime() + ms)

test('la oferta dura diez minutos o hasta el cierre, y no se emite con menos de un minuto', () => {
  assert.equal(offerExpiry(now, ends)?.getTime(), now.getTime() + OFFER_DURATION_MS)
  assert.equal(offerExpiry(now, plus(5 * 60_000))?.getTime(), plus(5 * 60_000).getTime())
  assert.equal(offerExpiry(now, plus(60_000))?.getTime(), plus(60_000).getTime())
  assert.equal(offerExpiry(now, plus(59_999)), null)
  assert.equal(offerExpiry(now, now), null)
})

test('ADR 0002: Ana 10, Pedro 3 y Juan 1 con 4 libres: solo la cabeza recibe, parcial y sin adelantos', () => {
  const queue = [{ id: 'ana', requestedQuantity: 10 }, { id: 'pedro', requestedQuantity: 3 }, { id: 'juan', requestedQuantity: 1 }]
  assert.deepEqual(planOffers(4, queue, now, ends).map(({ id, quantity }) => [id, quantity]), [['ana', 4]])
})

test('lo que sobra de la cabeza se ofrece a la siguiente en orden, nunca a una posterior saltándose a otra', () => {
  const queue = [{ id: 'ana', requestedQuantity: 2 }, { id: 'pedro', requestedQuantity: 3 }, { id: 'juan', requestedQuantity: 1 }]
  assert.deepEqual(planOffers(4, queue, now, ends).map(({ id, quantity }) => [id, quantity]), [['ana', 2], ['pedro', 2]])
  assert.deepEqual(planOffers(6, queue, now, ends).map(({ id, quantity }) => [id, quantity]), [['ana', 2], ['pedro', 3], ['juan', 1]])
  assert.deepEqual(planOffers(10, queue, now, ends).map(({ quantity }) => quantity), [2, 3, 1])
})

test('sin libres, cola vacía o con menos de un minuto de ventana no se ofrece', () => {
  const queue = [{ id: 'ana', requestedQuantity: 1 }]
  assert.deepEqual(planOffers(0, queue, now, ends), [])
  assert.deepEqual(planOffers(3, [], now, ends), [])
  assert.deepEqual(planOffers(3, queue, now, plus(30_000)), [])
  assert.ok(planOffers(3, queue, now, ends).every(offer => offer.expiresAt.getTime() === plus(OFFER_DURATION_MS).getTime()))
})

test('ingreso: reserva directa si alcanza y nadie espera; con cola nadie adelanta', () => {
  const lot = { quantity: 10, availableQuantity: 4, pickupEndsAt: ends }
  requireWaitlistEntry(lot, 10, false, false, now)
  requireWaitlistEntry(lot, 1, false, true, now)
  assert.throws(() => requireWaitlistEntry(lot, 4, false, false, now), { reason: 'directly_available' })
  assert.throws(() => requireWaitlistEntry(lot, 3, true, true, now), { reason: 'active_commitment' })
  assert.throws(() => requireWaitlistEntry(lot, 11, false, false, now), { reason: 'unavailable' })
  assert.throws(() => requireWaitlistEntry(lot, 5, false, false, ends), { reason: 'unavailable' })
  assert.throws(() => requireWaitlistEntry(lot, 0, false, false, now), ReservationRuleError)
  assert.throws(() => requireDirectReservation(lot, 1, false, now, true), { reason: 'unavailable' })
  requireDirectReservation(lot, 1, false, now, false)
})

test('estado vigente: la oferta vence a su hora y la espera al cierre, aunque nadie lo registre', () => {
  const lot = { pickupEndsAt: ends }
  const offered = { status: 'offered' as const, offerExpiresAt: plus(OFFER_DURATION_MS), endedAt: null }
  assert.equal(currentWaitlistStatus(offered, lot, plus(OFFER_DURATION_MS - 1)), 'offered')
  assert.equal(currentWaitlistStatus(offered, lot, plus(OFFER_DURATION_MS)), 'expired')
  assert.equal(waitlistEndedAt(offered, lot, plus(OFFER_DURATION_MS - 1)), null)
  assert.equal(waitlistEndedAt(offered, lot, plus(OFFER_DURATION_MS + 5000))?.getTime(), plus(OFFER_DURATION_MS).getTime())
  const waiting = { status: 'waiting' as const, offerExpiresAt: null, endedAt: null }
  assert.equal(currentWaitlistStatus(waiting, lot, new Date(ends.getTime() - 1)), 'waiting')
  assert.equal(currentWaitlistStatus(waiting, lot, ends), 'expired')
  assert.equal(waitlistEndedAt(waiting, lot, new Date(ends.getTime() + 9000))?.getTime(), ends.getTime())
  for (const status of ['accepted', 'declined', 'left', 'expired'] as const) {
    assert.equal(currentWaitlistStatus({ status, offerExpiresAt: null, endedAt: now }, lot, ends), status)
  }
})

test('un lote cerrado o retirado ya no asigna', () => {
  assert.equal(isAssignable({ status: 'published', pickupEndsAt: ends }, now), true)
  assert.equal(isAssignable({ status: 'published', pickupEndsAt: ends }, ends), false)
  assert.equal(isAssignable({ status: 'withdrawn', pickupEndsAt: ends }, now), false)
  assert.equal(isAssignable({ status: 'expired', pickupEndsAt: ends }, now), false)
})

test('transiciones: aceptar y rechazar exigen oferta vigente; repetir no repite el efecto', () => {
  const statuses: WaitlistStatus[] = ['waiting', 'offered', 'accepted', 'declined', 'expired', 'left']
  assert.deepEqual(statuses.map(status => decideAcceptance(status).kind), ['reject', 'apply', 'replay', 'reject', 'reject', 'reject'])
  assert.deepEqual(statuses.map(status => decideDecline(status).kind), ['reject', 'apply', 'reject', 'replay', 'reject', 'reject'])
  assert.deepEqual(statuses.map(status => decideLeave(status).kind), ['apply', 'reject', 'reject', 'reject', 'reject', 'replay'])
  assert.deepEqual(decideAcceptance('waiting'), { kind: 'reject', reason: 'not_offered' })
  assert.deepEqual(decideAcceptance('expired'), { kind: 'reject', reason: 'expired' })
  assert.deepEqual(decideDecline('accepted'), { kind: 'reject', reason: 'accepted' })
  assert.deepEqual(decideLeave('offered'), { kind: 'reject', reason: 'not_waiting' })
})
