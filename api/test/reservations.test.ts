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
test('Application decide con el instante de la base leído bajo bloqueo, no con su reloj', async () => {
  let inserted: Date | null = null
  const repository = (closing: Date) => ({
    withReservationTransaction: async (_user, _lot, _key, operate) =>
      operate({ existing: null, lot: lot as PublicLot, active: false, reconciled: true, now: closing }, {
        insert: async (quantity, createdAt) => { inserted = createdAt; return { id: 'r', lotId: 'a', quantity, createdAt } },
      }),
  }) as DiscoveryRepository
  const processClock = () => assert.fail('reserve no debe leer el reloj del proceso')
  await assert.rejects(createDiscoveryUseCases(repository(lot.pickupEndsAt), processClock)
    .reserve({ userId: '1' }, 'a', 1, 'b'), /unavailable/)
  await createDiscoveryUseCases(repository(at), processClock).reserve({ userId: '1' }, 'a', 1, 'b')
  assert.equal(inserted, at)
})
test('una clave usada devuelve su resultado o 409 sin releer el lote', async () => {
  const existing = { id: 'r', lotId: 'a', quantity: 2, createdAt: at }
  const repository = {
    withReservationTransaction: async (_user, _lot, _key, operate) =>
      operate({ existing }, { insert: async () => assert.fail('No insertar en un reintento') }),
  } as DiscoveryRepository
  const cases = createDiscoveryUseCases(repository, () => at)
  assert.equal(await cases.reserve({ userId: '1' }, 'A', 2, 'k'), existing)
  await assert.rejects(cases.reserve({ userId: '1' }, 'a', 1, 'k'), { code: 'idempotency_conflict' })
  await assert.rejects(cases.reserve({ userId: '1' }, 'b', 2, 'k'), { code: 'idempotency_conflict' })
})
test('una discrepancia de inventario bloquea asignar, pero no reproducir un resultado', async () => {
  const repository = {
    withReservationTransaction: async (_user, _lot, _key, operate) =>
      operate({ existing: null, lot: lot as PublicLot, active: false, reconciled: false, now: at }, {
        insert: async () => assert.fail('No asignar con contadores en discrepancia'),
      }),
  } as DiscoveryRepository
  await assert.rejects(createDiscoveryUseCases(repository, () => at).reserve({ userId: '1' }, 'A', 1, 'k'),
    { code: 'inventory_discrepancy', lotId: 'a' })
})
