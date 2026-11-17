import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { createPool } from '../../dist/infrastructure/postgres/pool.js'
import { createIdentityRepository } from '../../dist/infrastructure/postgres/identity-repository.js'
import { createDiscoveryRepository } from '../../dist/infrastructure/postgres/discovery-repository.js'
import { createReservationRepository } from '../../dist/infrastructure/postgres/reservation-repository.js'
import { createWaitlistRepository } from '../../dist/infrastructure/postgres/waitlist-repository.js'
import { createIncidentRepository } from '../../dist/infrastructure/postgres/incident-repository.js'
import { createDiscoveryUseCases } from '../../dist/application/discovery/use-cases.js'
import { createReservationUseCases } from '../../dist/application/reservations/use-cases.js'
import { createWaitlistUseCases } from '../../dist/application/waitlist/use-cases.js'
import { createIncidentUseCases } from '../../dist/application/incidents/use-cases.js'
import { createPickupCodes } from '../../dist/infrastructure/crypto/pickup-codes.js'
import { auditOperation } from '../../dist/application/recovery/journal.js'
import { createRecoveryJournal } from '../../dist/infrastructure/objects/recovery-journal.js'
import { readRecoveryJournal, reconciliationReport } from './recovery-journal.mjs'
import { Readable } from 'node:stream'

/** Compara el diario cifrado con una instantánea PostgreSQL anterior a operaciones reales. */
export async function testRecovery(databaseUrl) {
  const pool = createPool({ connectionString: databaseUrl })
  const snapshot = new pg.Client({ connectionString: databaseUrl })
  const objects = new Map()
  const key = randomBytes(32)
  const ids = createIdentityRepository(pool)
  const journal = createRecoveryJournal({ RECOVERY_JOURNAL_KEY: key.toString('base64'), RECOVERY_JOURNAL_SCOPE: 'test',
    PHOTO_S3_ENDPOINT: 'https://example.invalid', PHOTO_S3_BUCKET: 'private' }, id => ids.findUserById(id), {
    async send(command) {
      // Las dos escrituras externas deben ocurrir fuera de la transacción de negocio.
      const locks = await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND relation='lots'::regclass AND mode='RowExclusiveLock' AND granted`)
      assert.equal(locks.rows[0].n, 0)
      objects.set(command.input.Key, Buffer.from(command.input.Body))
    }, destroy() {},
  })
  const codes = createPickupCodes(randomBytes(32))
  const discovery = createDiscoveryUseCases(createDiscoveryRepository(pool), codes, () => new Date())
  const reservations = createReservationUseCases(createReservationRepository(pool), codes, () => new Date())
  const waitlist = createWaitlistUseCases(createWaitlistRepository(pool), codes, () => new Date())
  const incidents = createIncidentUseCases(createIncidentRepository(pool))
  const person = async label => {
    const row = (await pool.query('INSERT INTO users(email) VALUES ($1) RETURNING id::text,public_id::text', [`recovery-${label}-${randomUUID()}@example.invalid`])).rows[0]
    return { userId: row.id, publicId: row.public_id }
  }
  const run = (actor, operation, targetType, targetId, action) => {
    const intentKey = randomUUID()
    return auditOperation(journal, { actorId: actor.userId, operation, targetType, targetId, intentKey }, () => action(intentKey))
  }
  try {
    const operator = await person('operator')
    const [establishment] = (await pool.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
      VALUES ('Ensayo recuperación','Dirección ficticia',-33.45,-70.66,'America/Santiago') RETURNING id`)).rows
    await pool.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)', [operator.userId, establishment.id])
    const lot = (await pool.query(`INSERT INTO lots(establishment_id,description,category,quantity,address,latitude,longitude,time_zone,
      pickup_starts_at,pickup_ends_at,status,published_at) VALUES ($1,'Recuperación','Prueba',2,'Ficticia',-33.45,-70.66,'America/Santiago',
      now()-interval '1 hour',now()+interval '3 hours','published',now()) RETURNING public_id::text AS id`, [establishment.id])).rows[0].id
    await snapshot.connect()
    await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await snapshot.query('SELECT count(*) FROM users')
    const copiedAt = new Date(Date.now() - 1).toISOString()
    const holder = await person('new-holder'), other = await person('other'), waiting = await person('waiting')
    const reserve = async actor => run(actor, 'reservation.create', 'lot', lot, () => discovery.reserve(actor, lot, 1, randomUUID()))
    const first = await reserve(holder), second = await reserve(other)
    const joined = await run(waiting, 'waitlist.join', 'lot', lot, () => waitlist.join(waiting, lot, 1, randomUUID()))
    await run(other, 'reservation.cancel', 'reservation', second.id, () => reservations.cancel(other, second.id))
    const accepted = await run(waiting, 'waitlist.accept', 'waitlist', joined.id, () => waitlist.accept(waiting, joined.id))
    const code = (await reservations.get(holder, first.id)).pickupCode
    await run(operator, 'reservation.deliver', 'reservation', first.id,
      key => reservations.confirmPickup(operator, lot, first.id, code, key, () => {}))
    const offeredCode = (await reservations.get(waiting, accepted.reservationId)).pickupCode
    await run(operator, 'reservation.deliver', 'reservation', accepted.reservationId,
      key => reservations.confirmPickup(operator, lot, accepted.reservationId, offeredCode, key, () => {}))
    const incident = await run(holder, 'incident.report', 'lot', lot,
      () => incidents.report(holder, lot, { reason: 'Ensayo de recuperación', idempotencyKey: randomUUID() }))
    await run(operator, 'incident.publish', 'incident', incident.id,
      () => incidents.command(operator, incident.id, { action: 'publish', version: 0, reason: 'Ensayo', instructions: 'Contactar al establecimiento',
        idempotencyKey: randomUUID(), closeLot: false }))
    const store = { async list(prefix) { return [...objects.keys()].filter(key => key.startsWith(prefix)) },
      async get(path) { return objects.has(path) ? Readable.from([objects.get(path)]) : null } }
    const records = await readRecoveryJournal(store, 'test', key)
    assert.equal(records.length, 9)
    assert.equal((await snapshot.query('SELECT count(*)::int AS n FROM users WHERE public_id=$1', [holder.publicId])).rows[0].n, 0)
    const report = await reconciliationReport(snapshot, records, copiedAt)
    assert.equal(report.readyToReopen, false)
    assert.equal(report.items.length, 9)
    assert.ok(report.items.every(item => item.lotId === lot), 'reservas, cola y versiones se enlazan al lote perdido')
    assert.ok(report.items.every(item => item.contacts.some(contact => contact.id === holder.publicId)), 'cuenta posterior a la copia identificable')
    assert.equal(JSON.stringify(report).includes(code), false)
    const corrupted = [...objects.keys()][0]
    const envelope = JSON.parse(objects.get(corrupted)); envelope.tag = randomBytes(16).toString('base64')
    objects.set(corrupted, Buffer.from(JSON.stringify(envelope)))
    await assert.rejects(readRecoveryJournal(store, 'test', key))
    console.log('PASS #207: instantánea PostgreSQL anterior a 9 operaciones reales; identifica reservas, entregas directas y desde oferta, cola e incidencia y contactos nuevos; sin S3 bajo locks ni códigos en el informe; corrupción bloquea reapertura')
  } finally {
    await snapshot.query('ROLLBACK').catch(() => {}); await snapshot.end().catch(() => {})
    journal.close(); await pool.end()
  }
}
