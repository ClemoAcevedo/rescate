import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { requireLotCommand, LotManagementError } from '../src/domain/lot-management.js'
import type { LotCommand, ManagedLot } from '../src/domain/lot-management.js'
import { createLotManagement } from '../src/application/lots/management.js'
import type { LotManagementRepository, LotManagementView, StoredCommand } from '../src/application/lots/management.js'
import { nextPhotoPosition } from '../src/domain/photos.js'
import { readPhotoLimit } from '../src/composition.js'
const at = new Date('2030-01-01T12:00:00Z'), end = new Date('2030-01-01T13:00:00Z')
const state: ManagedLot = { status: 'published', version: 2, paused: false, freeQuantity: 1,
  offeredQuantity: 1, reservedQuantity: 1, deliveredQuantity: 1, unassignableQuantity: 0 }
const command = (action: LotCommand['action'], extra = {}): LotCommand => ({ action, version: 2,
  reason: 'Venta presencial', idempotencyKey: randomUUID(), ...extra })
test('solo se descuentan libres; se rechazan fracciones, negativos, ausencia de motivo y propiedades por acción', () => {
  requireLotCommand(state, command('reduce_stock', { quantity: 1 }), end, at)
  for (const quantity of [0, -1, 0.5, undefined, 2147483648]) assert.throws(
    () => requireLotCommand(state, command('reduce_stock', { quantity }), end, at), /invalid_command/)
  assert.throws(() => requireLotCommand(state, command('reduce_stock', { quantity: 2 }), end, at), /insufficient_stock/)
  assert.throws(() => requireLotCommand(state, command('pause', { quantity: 1 }), end, at), /invalid_command/)
  assert.throws(() => requireLotCommand(state, command('pause', { reason: ' ' }), end, at), /invalid_command/)
})
test('pausa reversible; no se modifica un lote cerrado ni se amplía el plazo de retiro', () => {
  requireLotCommand(state, command('pause'), end, at)
  requireLotCommand({ ...state, paused: true }, command('resume'), end, at)
  assert.throws(() => requireLotCommand(state, command('resume'), end, at), /not_paused/)
  assert.throws(() => requireLotCommand({ ...state, paused: true }, command('pause'), end, at), /already_paused/)
  for (const status of ['draft','expired','withdrawn'] as const) assert.throws(
    () => requireLotCommand({ ...state, status }, command('withdraw'), end, at), /closed/)
  assert.throws(() => requireLotCommand(state, command('withdraw'), at, at), /closed/)
})
test('cupo de fotos configurable, sin depender del antiguo máximo de tres', () => {
  assert.equal(readPhotoLimit({}), 3)
  assert.equal(readPhotoLimit({ PHOTO_MAX_PER_LOT: '6' }), 6)
  assert.equal(nextPhotoPosition('draft', [1,2,3], 6), 4)
  for (const raw of ['0','51','3.5','Infinity','-1']) assert.throws(() => readPhotoLimit({ PHOTO_MAX_PER_LOT: raw }))
  assert.throws(() => nextPhotoPosition('published', [], 6))
})
test('autorización antes del bloqueo y relectura del permiso dentro de la transacción', async () => {
  let locked = 0, allowed = false, stillAllowed = true
  const repository: LotManagementRepository = {
    find: async () => ({ establishmentId: 'e' }), isMember: async () => allowed,
    read: async () => ({ ...state, history: [] }),
    withCommand: async (_user, _lot, _key, operate) => {
      locked++
      return operate({ lot: state, establishmentId: 'e', pickupEndsAt: end, at, reconciled: true }, {
        settle: async () => { throw new Error('No debe asentar') },
        isMember: async () => stillAllowed, prior: async () => null,
        apply: async () => { throw new Error('No debe escribir') },
      })
    },
  }
  const app = createLotManagement(repository)
  await assert.rejects(app.command({ userId: 'u' }, randomUUID(), command('pause')), { code: 'not_authorized' })
  assert.equal(locked, 0)
  allowed = true; stillAllowed = false
  await assert.rejects(app.command({ userId: 'u' }, randomUUID(), command('pause')), { code: 'not_authorized' })
  assert.equal(locked, 1)
})
test('reintentar reproduce el resultado original antes de validar estado o versión; cambiar parámetros no escribe', async () => {
  const lotId = randomUUID(), input = command('reduce_stock', { quantity: 1 })
  const result: LotManagementView = { ...state, version: 3, freeQuantity: 0, unassignableQuantity: 1, history: [] }
  let writes = 0
  const prior: StoredCommand = { lotId, command: input, result }
  const repository: LotManagementRepository = {
    find: async () => ({ establishmentId: 'e' }), isMember: async () => true, read: async () => result,
    withCommand: async (_user, _lot, _key, operate) => operate({ lot: { ...state, status: 'withdrawn', version: 8 },
      establishmentId: 'e', pickupEndsAt: end, at, reconciled: false }, {
      settle: async () => { throw new Error('Un reintento no asienta') },
      isMember: async () => true, prior: async () => prior,
      apply: async () => { writes++; return result },
    }),
  }
  const app = createLotManagement(repository)
  assert.deepEqual(await app.command({ userId: 'u' }, lotId.toUpperCase(), input), result)
  await assert.rejects(app.command({ userId: 'u' }, lotId, { ...input, quantity: 2 }), { code: 'idempotency_conflict' })
  assert.equal(writes, 0)
})
