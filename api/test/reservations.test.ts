import test from 'node:test'
import assert from 'node:assert/strict'
import { requireDirectReservation, requireReservationQuantity, ReservationRuleError } from '../src/domain/reservations.js'
import { createDiscoveryUseCases } from '../src/application/discovery/use-cases.js'
import type { DiscoveryRepository, PublicLot } from '../src/application/discovery/ports.js'

const at = new Date('2030-01-01T12:00:00Z')
const lot = { quantity: 101, availableQuantity: 101, pickupEndsAt: new Date(at.getTime() + 1) }
test('cantidad entera y positiva, sin tope artificial de 2 o 100 packs', () => {
  for (const quantity of [0, -1, 0.5, NaN, Infinity, 2147483648]) {
    assert.throws(() => requireReservationQuantity(quantity), ReservationRuleError)
  }
  requireDirectReservation(lot, 101, false, at)
})
test('el cierre es exclusivo; un compromiso activo o falta de stock impiden reservar', () => {
  assert.throws(() => requireDirectReservation(lot, 1, false, lot.pickupEndsAt), /unavailable/)
  assert.throws(() => requireDirectReservation(lot, 1, true, at), /active_commitment/)
  assert.throws(() => requireDirectReservation({ ...lot, availableQuantity: 1 }, 2, false, at), /unavailable/)
})
test('Application lee el reloj una vez dentro de la transacción, después del bloqueo', async () => {
  let locked = false
  let clockReads = 0
  const repository = {
    withReservationTransaction: async (_user, _lot, _key, operate) => {
      locked = true
      return operate({ lot: lot as PublicLot, existing: null, active: false }, {
        insert: async () => { assert.fail('No insertar después del cierre') },
      })
    },
  } as DiscoveryRepository
  const cases = createDiscoveryUseCases(repository, () => {
    assert.equal(locked, true); clockReads++; return lot.pickupEndsAt
  })
  await assert.rejects(cases.reserve({ userId: '1' }, 'a', 1, 'b'), /unavailable/)
  assert.equal(clockReads, 1)
})
