import assert from 'node:assert/strict'
import { decryptRecoveryRecord } from '../../dist/infrastructure/objects/recovery-journal.js'
import { BACKUP_PREFIX } from './encrypted-backups.mjs'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function journalPrefix(scope) {
  assert.match(scope ?? '', /^[a-z0-9-]{1,64}$/i, 'Se requiere el scope del entorno de origen')
  return `${BACKUP_PREFIX}journal/${scope}/`
}

export async function readRecoveryJournal(store, scope, key) {
  const prefix = journalPrefix(scope)
  const keys = await store.list(prefix)
  const pattern = /^(\d{4}-\d{2}-\d{2})\/([a-f0-9-]{36})\/(prepared|outcome)\.json$/
  const records = new Map()
  for (const path of keys) {
    const match = pattern.exec(path.slice(prefix.length))
    assert.ok(path.startsWith(prefix) && match && uuid.test(match[2]), 'Clave de diario desconocida; revisión manual requerida')
    const body = await store.get(path)
    assert.ok(body, 'Falta una parte del diario')
    const chunks = []; let length = 0
    for await (const chunk of body) { length += chunk.length; assert.ok(length <= 64 * 1024); chunks.push(Buffer.from(chunk)) }
    const value = decryptRecoveryRecord(Buffer.concat(chunks), key)
    assert.ok(value.id === match[2] && value.preparedAt?.slice(0, 10) === match[1]
      && Number.isFinite(Date.parse(value.preparedAt)) && Number.isFinite(Date.parse(value.recordedAt)), 'Diario inconsistente')
    const record = records.get(value.id) ?? {}
    record[match[3]] = value
    records.set(value.id, record)
  }
  return [...records.values()].map(({ prepared, outcome }) => {
    assert.ok(prepared?.phase === 'prepared' && prepared.scope === scope && prepared.facts
      && uuid.test(prepared.facts.targetId) && ['lot', 'reservation', 'waitlist', 'incident', 'establishment'].includes(prepared.facts.targetType), 'Intención incompleta')
    assert.ok(!outcome || outcome.preparedAt === prepared.preparedAt && ['confirmed', 'rejected', 'uncertain'].includes(outcome.phase), 'Resultado inconsistente')
    return { ...prepared, outcome: outcome ?? { phase: 'uncertain' } }
  }).sort((a, b) => a.preparedAt.localeCompare(b.preparedAt) || a.id.localeCompare(b.id))
}

/** Solo borra el diario que queda fuera de todas las copias conservadas y de ocho días de margen. */
export async function rotateRecoveryJournal(store, scope, copies, now = Date.now()) {
  const threshold = Math.min(now - 8 * 86400_000, ...copies.map(copy => Date.parse(copy.createdAt)))
  assert.ok(Number.isFinite(threshold) && copies.length > 0, 'Sin copias verificadas no se rota el diario')
  const prefix = journalPrefix(scope)
  let removed = 0
  for (const path of await store.list(prefix)) {
    const suffix = path.slice(prefix.length)
    const match = /^(\d{4}-\d{2}-\d{2})\/[a-f0-9-]{36}\/(prepared|outcome)\.json$/.exec(suffix)
    assert.ok(path.startsWith(prefix) && match, 'Inventario desconocido; se detiene la rotación del diario')
    if (Date.parse(`${match[1]}T00:00:00Z`) + 86400_000 <= threshold) { await store.remove(path); removed++ }
  }
  return removed
}

async function restoredEffect(client, record) {
  const { operation, targetId, intentKey } = record.facts
  const result = record.outcome.result ?? {}
  if (operation === 'reservation.create') {
    return (await client.query('SELECT 1 FROM commitments WHERE public_id=$1', [result.id])).rowCount > 0
  }
  if (operation === 'reservation.cancel') {
    return (await client.query("SELECT 1 FROM commitments WHERE public_id=$1 AND status='cancelled'", [targetId])).rowCount > 0
  }
  if (operation === 'reservation.deliver') {
    return (await client.query(`SELECT 1 FROM deliveries d JOIN users u ON u.id=d.operator_user_id
      JOIN commitments c ON c.id=d.commitment_id WHERE u.public_id=$1 AND d.idempotency_key=$2 AND c.public_id=$3`,
    [record.actor?.id, intentKey, targetId])).rowCount > 0
  }
  if (operation.startsWith('waitlist.')) {
    const id = operation === 'waitlist.join' ? result.id : targetId
    return (await client.query('SELECT 1 FROM waitlist_entries WHERE public_id=$1 AND status=$2', [id, result.status])).rowCount > 0
  }
  if (operation.startsWith('incident.')) {
    const id = operation === 'incident.report' ? result.id : targetId
    return (await client.query('SELECT 1 FROM incidents WHERE public_id=$1 AND version >= $2', [id, result.version ?? 0])).rowCount > 0
  }
  if (operation.startsWith('lot.') && Number.isSafeInteger(result.version)) {
    return (await client.query('SELECT 1 FROM lots WHERE public_id=$1 AND version >= $2', [targetId, result.version])).rowCount > 0
  }
  // Los vencimientos no devuelven versión: conservarlos para revisión antes de reabrir.
  return false
}

export async function reconciliationReport(client, records, copyCreatedAt) {
  assert.ok(Number.isFinite(Date.parse(copyCreatedAt)), 'Fecha de copia incorrecta')
  const candidates = records.filter(record => record.outcome.phase !== 'rejected'
    && (record.outcome.phase !== 'confirmed' || Date.parse(record.outcome.recordedAt) >= Date.parse(copyCreatedAt)))
  const links = new Map()
  for (const record of records) {
    if (record.facts.targetType === 'lot' && uuid.test(record.outcome.result?.id ?? '')) {
      const type = record.facts.operation.startsWith('reservation.') ? 'reservation' : record.facts.operation.startsWith('waitlist.') ? 'waitlist' : 'incident'
      links.set(`${type}/${record.outcome.result.id}`, record.facts.targetId)
    }
  }
  // Una oferta aceptada crea una reserva sin pasar por reservation.create.
  for (const record of records) {
    const reservationId = record.outcome.result?.reservationId
    const lotId = record.facts.targetType === 'lot' ? record.facts.targetId
      : links.get(`${record.facts.targetType}/${record.facts.targetId}`)
    if (lotId && uuid.test(reservationId ?? '')) links.set(`reservation/${reservationId}`, lotId)
  }
  const items = []
  for (const record of candidates) {
    if (record.outcome.phase === 'confirmed' && await restoredEffect(client, record)) continue
    const { targetType, targetId } = record.facts
    let lotId = targetType === 'lot' ? targetId : links.get(`${targetType}/${targetId}`)
    if (!lotId && ['reservation', 'waitlist', 'incident'].includes(targetType)) {
      const table = { reservation: 'commitments', waitlist: 'waitlist_entries', incident: 'incidents' }[targetType]
      const found = await client.query(`SELECT l.public_id::text AS id FROM ${table} t JOIN lots l ON l.id=t.lot_id WHERE t.public_id=$1`, [targetId])
      lotId = found.rows[0]?.id
    }
    const contacts = new Map()
    const remember = actor => { if (actor?.id && actor.email) contacts.set(actor.id, actor) }
    remember(record.actor)
    if (lotId) {
      // Incluye también titulares que nacieron después de la copia, desde el diario independiente.
      for (const other of records) if (other.facts.targetId === lotId || links.get(`${other.facts.targetType}/${other.facts.targetId}`) === lotId) remember(other.actor)
      const restored = await client.query(`SELECT DISTINCT u.public_id::text AS id, u.email FROM users u WHERE
        u.id IN (SELECT c.user_id FROM commitments c JOIN lots l ON l.id=c.lot_id WHERE l.public_id=$1
          UNION SELECT w.user_id FROM waitlist_entries w JOIN lots l ON l.id=w.lot_id WHERE l.public_id=$1
          UNION SELECT m.user_id FROM memberships m JOIN lots l ON l.establishment_id=m.establishment_id WHERE l.public_id=$1)`, [lotId])
      restored.rows.forEach(remember)
    }
    items.push({ id: record.id, preparedAt: record.preparedAt, operation: record.facts.operation,
      targetType, targetId, lotId: lotId ?? null, outcome: record.outcome.phase,
      result: record.outcome.result ?? null, contacts: [...contacts.values()], decision: null })
  }
  return { format: 1, copyCreatedAt, generatedAt: new Date().toISOString(), readyToReopen: items.length === 0, items }
}

export function applyDecisions(report, decisions) {
  assert.ok(Array.isArray(decisions) && decisions.length === report.items.length, 'Cada caso requiere una decisión')
  const byId = new Map(decisions.map(item => [item.id, item]))
  assert.equal(byId.size, decisions.length, 'Decisiones duplicadas')
  for (const item of report.items) {
    const decision = byId.get(item.id)
    assert.ok(decision && ['contacted', 'reconciled', 'no_effect'].includes(decision.action)
      && typeof decision.evidence === 'string' && decision.evidence.trim().length >= 10 && decision.evidence.length <= 1000,
    'Indicar decisión y evidencia para cada caso, sin códigos ni secretos')
    item.decision = decision
  }
  report.readyToReopen = true
  return report
}
