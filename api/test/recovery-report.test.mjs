import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { applyDecisions, reconciliationReport, rotateRecoveryJournal } from '../scripts/support/recovery-journal.mjs'

test('conciliación conserva cuenta posterior a la copia, enlaza retiro con lote e incluye efectos inciertos', async () => {
  const lot = randomUUID(), reservation = randomUUID(), holder = randomUUID(), operator = randomUUID()
  const record = (facts, actor, outcome) => ({ id: randomUUID(), preparedAt: '2030-01-01T13:00:00Z', facts, actor,
    outcome: { phase: 'confirmed', recordedAt: '2030-01-01T13:00:01Z', ...outcome } })
  const records = [
    record({ operation: 'reservation.create', targetType: 'lot', targetId: lot },
      { id: holder, email: 'cuenta-nueva@example.invalid' }, { result: { id: reservation, status: 'confirmed' } }),
    record({ operation: 'reservation.deliver', targetType: 'reservation', targetId: reservation, intentKey: randomUUID() },
      { id: operator, email: 'operador@example.invalid' }, { result: { id: '72' } }),
    record({ operation: 'waitlist.accept', targetType: 'waitlist', targetId: randomUUID() },
      { id: holder, email: 'cuenta-nueva@example.invalid' }, { phase: 'uncertain' }),
    record({ operation: 'reservation.create', targetType: 'lot', targetId: lot }, null, { phase: 'rejected' }),
  ]
  const client = { async query(sql) {
    assert.ok(!/INSERT|UPDATE|DELETE/i.test(sql), 'el informe solo consulta')
    return { rows: [], rowCount: 0 }
  } }
  const report = await reconciliationReport(client, records, '2030-01-01T12:00:00Z')
  assert.equal(report.readyToReopen, false)
  assert.equal(report.items.length, 3)
  const delivery = report.items.find(item => item.operation === 'reservation.deliver')
  assert.equal(delivery.lotId, lot)
  assert.ok(delivery.contacts.some(person => person.id === holder), 'no depende de que exista la cuenta en la base restaurada')
  assert.throws(() => applyDecisions(report, []))
  assert.throws(() => applyDecisions(report, report.items.map(item => ({ id: item.id, action: 'no_effect', evidence: '' }))))
  assert.equal(applyDecisions(report, report.items.map(item => ({ id: item.id, action: 'contacted', evidence: 'Contactado y acordada una nueva reserva.' }))).readyToReopen, true)
})

test('reintento idempotente ya incluido en la copia no se informa como operación perdida', async () => {
  const record = { id: randomUUID(), preparedAt: '2030-01-01T13:00:00Z',
    facts: { operation: 'reservation.create', targetType: 'lot', targetId: randomUUID() },
    outcome: { phase: 'confirmed', recordedAt: '2030-01-01T13:00:01Z', result: { id: randomUUID() } } }
  const report = await reconciliationReport({ async query() { return { rows: [{}], rowCount: 1 } } }, [record], '2030-01-01T12:00:00Z')
  assert.equal(report.items.length, 0)
  assert.equal(report.readyToReopen, true)
})

test('retención del diario cubre ocho días y la copia más antigua; no borra fotos ni otro entorno', async () => {
  const prefix = 'rescate-backups/v1/journal/source/'
  const paths = ['2030-01-01', '2030-01-02', '2030-01-09'].map(day => `${prefix}${day}/${randomUUID()}/prepared.json`)
  const removed = []
  const store = { async list(value) { assert.equal(value, prefix); return paths }, async remove(value) { removed.push(value) } }
  await rotateRecoveryJournal(store, 'source', [{ createdAt: '2030-01-02T12:00:00Z' }], Date.parse('2030-01-11T12:00:00Z'))
  assert.deepEqual(removed, [paths[0]])
  await assert.rejects(rotateRecoveryJournal(store, 'source', []))
})
