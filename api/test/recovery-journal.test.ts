import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import type { S3Client } from '@aws-sdk/client-s3'
import { auditOperation, RecoveryJournalUnavailableError } from '../src/application/recovery/journal.js'
import { createRecoveryJournal, decryptRecoveryRecord, recoveryResult } from '../src/infrastructure/objects/recovery-journal.js'

const facts = { operation: 'reservation.create', actorId: '12', targetType: 'lot' as const, targetId: randomUUID() }
function fixture() {
  const key = randomBytes(32)
  const values = new Map<string, Buffer>()
  let unavailable = false
  const transport = { async send(command: { input: { Key: string; Body: Buffer } }) {
    if (unavailable) throw new Error('S3 con datos internos que nunca deben propagarse')
    values.set(command.input.Key, command.input.Body)
  }, destroy() {} } as unknown as Pick<S3Client, 'send' | 'destroy'>
  const journal = createRecoveryJournal({ RECOVERY_JOURNAL_KEY: key.toString('base64'), RECOVERY_JOURNAL_SCOPE: 'test',
    PHOTO_S3_ENDPOINT: 'https://example.invalid', PHOTO_S3_BUCKET: 'private' },
  async () => ({ publicId: randomUUID(), email: 'persona@example.invalid' }), transport)!
  return { journal, key, values, fail: () => { unavailable = true } }
}

test('diario independiente: prepara antes de escribir, confirma después y cifra el contacto y los identificadores', async () => {
  const { journal, key, values } = fixture()
  const reservation = randomUUID()
  const result = await auditOperation(journal, facts, async () => {
    assert.equal(values.size, 1, 'la intención existe antes de abrir la unidad atómica')
    return { id: reservation, status: 'confirmed', pickupCode: 'SECRETO', email: 'sobrante@example.invalid', reason: 'texto privado' }
  })
  assert.equal(result.pickupCode, 'SECRETO', 'la respuesta de negocio conserva su contrato')
  assert.equal(values.size, 2)
  const [preparedBytes, outcomeBytes] = [...values.values()]
  for (const bytes of values.values()) {
    assert.equal(bytes.includes(Buffer.from('persona@example.invalid')), false)
    assert.equal(bytes.includes(Buffer.from(reservation)), false)
  }
  const prepared = decryptRecoveryRecord(preparedBytes!, key) as { actor: { email: string } }
  assert.equal(prepared.actor.email, 'persona@example.invalid')
  const outcome = decryptRecoveryRecord(outcomeBytes!, key)
  assert.deepEqual(outcome.result, { id: reservation, status: 'confirmed' })
  assert.equal(outcome.phase, 'confirmed')
  assert.throws(() => decryptRecoveryRecord(outcomeBytes!, randomBytes(32)))
  const envelope = JSON.parse(outcomeBytes!.toString()); envelope.data = Buffer.from('alterado').toString('base64')
  assert.throws(() => decryptRecoveryRecord(Buffer.from(JSON.stringify(envelope)), key))
})

test('falla cerrada antes del efecto; resultado desconocido después de COMMIT conserva la intención para conciliar', async () => {
  const before = fixture(); before.fail()
  let writes = 0
  await assert.rejects(auditOperation(before.journal, facts, async () => { writes++; return {} }), RecoveryJournalUnavailableError)
  assert.equal(writes, 0)
  const after = fixture()
  await assert.rejects(auditOperation(after.journal, facts, async () => { writes++; after.fail(); return {} }), RecoveryJournalUnavailableError)
  assert.equal(writes, 1)
  assert.equal(after.values.size, 1, 'la intención no se elimina al perderse la confirmación')
  const unknown = fixture()
  await assert.rejects(auditOperation(unknown.journal, facts, async () => { throw new Error('COMMIT: conexión perdida') }))
  const outcome = decryptRecoveryRecord([...unknown.values.values()][1]!, unknown.key)
  assert.equal(outcome.phase, 'uncertain')
})

test('proyección mínima y configuración explícita en producción', () => {
  assert.deepEqual(recoveryResult({ id: 'a', pickupCode: 'secreto', token: 'sesión', nested: { email: 'x' }, version: 2 }), { id: 'a', version: 2 })
  assert.equal(createRecoveryJournal({}, async () => null), null)
  assert.throws(() => createRecoveryJournal({ NODE_ENV: 'production' }, async () => null))
})
