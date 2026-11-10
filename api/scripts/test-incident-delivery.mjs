// K044: protocolo de cierre, versiones de avisos y recuperación con PostgreSQL real.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import pg from 'pg'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createIncidentRepository, createIncidentDispatchRepository } from '../dist/infrastructure/postgres/incident-repository.js'
import { createIncidentUseCases, createIncidentDispatcher } from '../dist/application/incidents/use-cases.js'
import { createDiscoveryRepository } from '../dist/infrastructure/postgres/discovery-repository.js'
import { createDiscoveryUseCases } from '../dist/application/discovery/use-cases.js'
import { createReservationRepository } from '../dist/infrastructure/postgres/reservation-repository.js'
import { createReservationUseCases } from '../dist/application/reservations/use-cases.js'
import { createWaitlistRepository } from '../dist/infrastructure/postgres/waitlist-repository.js'
import { createWaitlistUseCases } from '../dist/application/waitlist/use-cases.js'
import { createLotManagementRepository } from '../dist/infrastructure/postgres/lot-management-repository.js'
import { createLotManagement } from '../dist/application/lots/management.js'
import { createPickupCodes } from '../dist/infrastructure/crypto/pickup-codes.js'
import { createOutboxRepository, createNotificationRepository } from '../dist/infrastructure/postgres/notification-repository.js'
import { createOutboxProcessor } from '../dist/application/notifications/use-cases.js'
import { createOperations } from '../dist/infrastructure/postgres/operations.js'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_k044_test_/.test(new URL(connectionString).pathname.slice(1)), 'Solo base dedicada K044')
const pool = createPool({ connectionString }), gateDb = new pg.Client({ connectionString })
const codes = createPickupCodes(randomBytes(32)), now = () => new Date()
const repository = createIncidentRepository(pool), incidents = createIncidentUseCases(repository)
const dispatcher = createIncidentDispatcher(createIncidentDispatchRepository(pool))
const outbox = createOutboxRepository(pool), processor = createOutboxProcessor(outbox, now)
const notificationRepository = createNotificationRepository(pool)
const reservationRepository = createReservationRepository(pool)
const reservations = createReservationUseCases(reservationRepository, codes, now)
const discovery = createDiscoveryUseCases(createDiscoveryRepository(pool), codes, now)
const waitlist = createWaitlistUseCases(createWaitlistRepository(pool), codes, now)
const management = createLotManagement(createLotManagementRepository(pool))
const query = async (sql, values) => (await pool.query(sql, values)).rows
const person = async () => ({ userId: (await query('INSERT INTO users(email) VALUES ($1) RETURNING id::text', [`k044-${randomUUID()}@example.invalid`]))[0].id })
const command = (action = 'publish', version = 0, extra = {}) => ({ action, version,
  reason: 'Problema detectado en el contenido', instructions: 'No consumir; contactar al establecimiento', idempotencyKey: randomUUID(), ...extra })
const report = (actor, lot) => incidents.report(actor, lot, { reason: 'Problema reportado', idempotencyKey: randomUUID() })
const reserve = (actor, lot) => discovery.reserve(actor, lot, 1, randomUUID())
const deliver = (actor, lot, reservation, code, cases = reservations) => cases.confirmPickup(actor, lot, reservation, code, randomUUID(), () => {})
const lotState = async lot => (await query(`SELECT status,version,closed_at,paused_at,free_quantity,offered_quantity,
  reserved_quantity,delivered_quantity,expired_quantity FROM lots WHERE public_id=$1`, [lot]))[0]
const pending = async incident => query(`SELECT r.* FROM incident_recipients r JOIN incidents i ON i.id=r.incident_id
  WHERE i.public_id=$1 AND r.outbox_event_id IS NULL`, [incident])
const events = async incident => query(`SELECT e.* FROM outbox_events e JOIN incidents i ON i.id=e.subject_id
  WHERE e.event_type='incident_version' AND i.public_id=$1 ORDER BY e.version,e.recipient_user_id`, [incident])
const drain = async () => {
  while (await dispatcher.processNext()) {}
  while (await processor.processNext()) {}
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function until(predicate, label, timeout = 1500) {
  const start = Date.now()
  while (!await predicate()) {
    assert.ok(Date.now() - start < timeout, label)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function blockedLot() {
  await until(async () => (await query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
    AND wait_event_type='Lock' AND query LIKE '%FROM public.lots WHERE public_id%'`)).length > 0, 'bloqueo de lote observado')
}
let worker
const startWorker = () => {
  worker = spawn(process.execPath, ['dist/worker.js'], { stdio: 'ignore', env: { ...process.env,
    DATABASE_URL: connectionString, WORKER_EXPIRIES: 'off', PHOTO_STORAGE: '' } })
  return worker
}
const stopWorker = async signal => {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return
  const ended = new Promise(resolve => worker.once('exit', resolve))
  worker.kill(signal)
  await ended
}
let checks = 0
const ok = label => console.log(`OK K044 ${++checks}: ${label}`)

try {
  await gateDb.connect()
  const operator = await person(), outsider = await person()
  const est = (await query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('K044','Santiago',-33.45,-70.66,'America/Santiago') RETURNING id::text`))[0].id
  await query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)', [operator.userId, est])
  const lot = async quantity => (await query(`INSERT INTO lots(establishment_id,description,category,quantity,address,
    latitude,longitude,time_zone,pickup_starts_at,pickup_ends_at,status,published_at)
    VALUES ($1,'Lote K044','Prueba',$2,'Santiago',-33.45,-70.66,'America/Santiago',now()-interval '1 hour',
      now()+interval '2 hours','published',now()) RETURNING public_id::text AS id`, [est, quantity]))[0].id

  const mixed = await lot(6), [received, active, cancelled, offered, waiting] = await Promise.all(Array.from({ length: 5 }, person))
  const receivedReservation = await reserve(received, mixed)
  await deliver(operator, mixed, receivedReservation.id, (await reservations.get(received, receivedReservation.id)).pickupCode)
  const activeReservation = await reserve(active, mixed), activeCode = (await reservations.get(active, activeReservation.id)).pickupCode
  const cancelledReservation = await reserve(cancelled, mixed)
  await waitlist.join(offered, mixed, 6, randomUUID()); await waitlist.join(waiting, mixed, 1, randomUUID())
  await management.command(operator, mixed, { action: 'pause', version: 1, reason: 'Pausa', idempotencyKey: randomUUID() })
  await reservations.cancel(cancelled, cancelledReservation.id)
  const before = await lotState(mixed)
  assert.deepEqual([before.free_quantity,before.offered_quantity,before.reserved_quantity,before.delivered_quantity], [1,3,1,1])
  const incident = await report(active, mixed), close = command('publish', 0, { closeLot: true })
  await assert.rejects(incidents.command(outsider, incident.id, close), { code: 'incident_not_found' })
  const result = await incidents.command(operator, incident.id, close)
  assert.equal(result.closeLot, true); assert.equal(result.lotClosed, true)
  const closed = await lotState(mixed)
  assert.equal(closed.status, 'withdrawn'); assert.equal(closed.paused_at, null)
  assert.deepEqual([closed.free_quantity,closed.offered_quantity,closed.reserved_quantity,closed.delivered_quantity,closed.expired_quantity], [0,0,0,1,5])
  assert.equal((await query(`SELECT count(*)::int n FROM commitments c JOIN lots l ON l.id=c.lot_id
    WHERE l.public_id=$1 AND (c.status='confirmed' OR c.pickup_code_ciphertext IS NOT NULL)`, [mixed]))[0].n, 0)
  assert.equal((await query(`SELECT count(*)::int n FROM waitlist_entries w JOIN lots l ON l.id=w.lot_id
    WHERE l.public_id=$1 AND w.status IN ('waiting','offered')`, [mixed]))[0].n, 0)
  await assert.rejects(deliver(operator, mixed, activeReservation.id, activeCode), /cancelled/)
  await assert.rejects(reserve(outsider, mixed), { code: 'lot_not_found' })
  assert.equal((await pending(incident.id)).length, 6); assert.equal((await events(incident.id)).length, 0)
  assert.deepEqual(await incidents.command(operator, incident.id, close), result)
  await assert.rejects(incidents.command(operator, incident.id, { ...close, closeLot: false }), { code: 'idempotency_conflict' })
  await incidents.command(operator, incident.id, command('resolve', 1))
  assert.deepEqual(await lotState(mixed), closed)
  ok('cierre explícito F/O/R→X, conserva E, termina cola e invalida código; reintento y resolución no reabren')

  await drain()
  const notices = await events(incident.id)
  assert.equal(notices.length, 12)
  for (const version of [1,2]) {
    const rows = notices.filter(e => e.version === version)
    assert.equal(new Set(rows.map(e => e.recipient_user_id)).size, 6)
    assert.equal(rows.find(e => String(e.recipient_user_id) === received.userId).payload.incident.relation, 'received')
    assert.equal(rows.find(e => String(e.recipient_user_id) === cancelled.userId).payload.incident.relation, 'committed')
    assert.equal(rows.find(e => String(e.recipient_user_id) === operator.userId).payload.incident.relation, 'operator')
  }
  assert.ok(!JSON.stringify(notices).includes(activeCode))
  const own = await notificationRepository.listByUser(received.userId, 1)
  const notice = own.items.find(n => n.kind === 'incident_version')
  assert.equal(notice.readAt, null)
  assert.equal(await notificationRepository.markRead(outsider.userId, notice.id, now()), null)
  await notificationRepository.markRead(received.userId, notice.id, now())
  assert.deepEqual(await lotState(mixed), closed)
  ok('todos reciben un aviso por versión, con relación e instrucciones, sin códigos; lectura propia sin efectos')

  // Mantener el ganador dentro de su transacción hasta observar al perdedor esperando el lote.
  for (const winner of ['delivery','closure']) {
    const raced = await lot(1), holder = await person(), reservation = await reserve(holder, raced)
    const code = (await reservations.get(holder, reservation.id)).pickupCode, raceIncident = await report(operator, raced)
    const entered = deferred(), release = deferred()
    const heldClosure = createIncidentUseCases({ ...repository,
      withCommand: (user, id, key, operate) => repository.withCommand(user, id, key, (state, writer) => operate(state, {
        ...writer, closeLot: async (...args) => { await writer.closeLot(...args); entered.resolve(); await release.promise },
      })),
    })
    const heldDelivery = createReservationUseCases({ ...reservationRepository,
      withPickupAttempts: (user, operate) => reservationRepository.withPickupAttempts(user, (attempts, steps) => operate(attempts, {
        ...steps, confirm: (lotId, id, fingerprint, key, run) => steps.confirm(lotId, id, fingerprint, key, (state, writer) => run(state, {
          deliver: async at => { const value = await writer.deliver(at); entered.resolve(); await release.promise; return value },
        })),
      })),
    }, codes, now)
    const closeCommand = command('publish', 0, { closeLot: true })
    const first = winner === 'delivery' ? deliver(operator, raced, reservation.id, code, heldDelivery)
      : heldClosure.command(operator, raceIncident.id, closeCommand)
    await entered.promise
    const second = winner === 'delivery' ? incidents.command(operator, raceIncident.id, closeCommand)
      : deliver(operator, raced, reservation.id, code)
    const secondResult = second.then(value => ({ value }), error => ({ error }))
    try { await blockedLot() } finally { release.resolve() }
    await first
    const outcome = await secondResult
    if (winner === 'delivery') assert.ok(outcome.value)
    else assert.equal(outcome.error?.reason, 'cancelled')
    const state = await lotState(raced)
    assert.equal(state.delivered_quantity, winner === 'delivery' ? 1 : 0)
    await drain()
    const holderNotice = (await events(raceIncident.id)).find(e => String(e.recipient_user_id) === holder.userId)
    assert.equal(holderNotice.payload.incident.relation, winner === 'delivery' ? 'received' : 'committed')
  }
  ok('ambos órdenes de la carrera cierre/entrega con bloqueo observado y aviso coherente con el ganador')

  const rollbackLot = await lot(1), rollbackHolder = await person(), held = await reserve(rollbackHolder, rollbackLot)
  const rollbackIncident = await report(operator, rollbackLot), beforeRollback = await lotState(rollbackLot)
  const failing = createIncidentUseCases({ ...repository,
    withCommand: (user, id, key, operate) => repository.withCommand(user, id, key, (state, writer) => operate(state, {
      ...writer, publish: async (...args) => { await writer.publish(...args); throw new Error('fallo tras cerrar y publicar') },
    })),
  })
  const recovering = command('publish', 0, { closeLot: true })
  await assert.rejects(failing.command(operator, rollbackIncident.id, recovering), /fallo tras cerrar/)
  assert.deepEqual(await lotState(rollbackLot), beforeRollback)
  assert.ok((await reservations.get(rollbackHolder, held.id)).pickupCode)
  assert.equal((await pending(rollbackIncident.id)).length, 0)
  await incidents.command(operator, rollbackIncident.id, recovering)
  await drain()
  ok('un fallo tras cerrar y escribir versión revierte inventario, código, estado y destinatarios; misma clave recuperable')

  const endedLot = await lot(1), endedIncident = await report(operator, endedLot)
  await query("UPDATE lots SET pickup_ends_at=now()-interval '1 minute' WHERE public_id=$1", [endedLot])
  const ends = (await query('SELECT pickup_ends_at FROM lots WHERE public_id=$1', [endedLot]))[0].pickup_ends_at
  await incidents.command(operator, endedIncident.id, command('publish', 0, { closeLot: true }))
  const ended = await lotState(endedLot)
  assert.equal(ended.status, 'expired'); assert.deepEqual(ended.closed_at, ends)
  await incidents.command(operator, endedIncident.id, command('update', 1, { closeLot: true }))
  assert.deepEqual(await lotState(endedLot), ended)
  await drain()
  ok('cerrar después del plazo conserva la hora de vencimiento; un cierre previo no se reescribe')

  const lateLot = await lot(2), lateIncident = await report(operator, lateLot), joiner = await person()
  await incidents.command(operator, lateIncident.id, command())
  await drain()
  await reserve(joiner, lateLot)
  assert.equal((await pending(lateIncident.id)).length, 1)
  await drain()
  assert.equal((await events(lateIncident.id)).filter(e => String(e.recipient_user_id) === joiner.userId).length, 1)
  ok('una reserva posterior al envío de la primera tanda genera su aviso vigente sin omisiones')

  // Dos dispatchers compiten por cien destinatarios sin bloquear el lote ni duplicar eventos.
  const crowded = await lot(1), crowdIncident = await report(operator, crowded)
  await query(`WITH people AS (INSERT INTO users(email) SELECT 'k044-crowd-'||gen_random_uuid()||'@example.invalid'
    FROM generate_series(1,99) RETURNING id)
    INSERT INTO commitments(user_id,lot_id,quantity,status,created_at,ended_at,idempotency_key)
    SELECT p.id,l.id,1,'cancelled',now(),now(),gen_random_uuid() FROM people p CROSS JOIN lots l WHERE l.public_id=$1`, [crowded])
  await incidents.command(operator, crowdIncident.id, command())
  const backlog = await createOperations(pool, 5).readBacklog()
  assert.equal(backlog.find(q => q.queue === 'notifications').pending, 100)
  const batches = await Promise.all([dispatcher.processNext(),dispatcher.processNext()])
  assert.deepEqual(batches, [50,50])
  assert.equal((await events(crowdIncident.id)).length, 100); assert.equal((await pending(crowdIncident.id)).length, 0)
  ok('dos dispatchers: tandas de 50, cien eventos únicos y pendientes visibles en operación')

  // Un worker real muere tras reclamar y antes de insertar su primer aviso.
  await gateDb.query('BEGIN'); await gateDb.query('SELECT pg_advisory_xact_lock(440044)')
  await query(`CREATE FUNCTION block_k044_notice() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(440044); RETURN NEW; END $$`)
  await query('CREATE TRIGGER block_k044_notice BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION block_k044_notice()')
  startWorker()
  await until(async () => (await query("SELECT count(*)::int n FROM outbox_events WHERE status='pending' AND claimed_until IS NOT NULL"))[0].n === 50,
    'el worker real reclamó una tanda de 50', 10000)
  await stopWorker('SIGKILL')
  await gateDb.query('COMMIT')
  await query('DROP TRIGGER block_k044_notice ON notifications'); await query('DROP FUNCTION block_k044_notice()')
  await query("UPDATE outbox_events SET claimed_until=now()-interval '1 second' WHERE status='pending'")
  const restartedAt = Date.now()
  startWorker()
  await until(async () => (await query(`SELECT count(*)::int n FROM notifications n JOIN outbox_events e ON e.id=n.event_id
    JOIN incidents i ON i.id=e.subject_id WHERE e.event_type='incident_version' AND i.public_id=$1`, [crowdIncident.id]))[0].n === 100,
    'reinicio genera cien avisos persistentes en hasta treinta segundos', 30000)
  await stopWorker('SIGTERM')
  assert.ok(Date.now()-restartedAt < 30000)
  assert.equal((await query(`SELECT count(*)::int n FROM notifications n JOIN outbox_events e ON e.id=n.event_id
    JOIN incidents i ON i.id=e.subject_id WHERE e.event_type='incident_version' AND i.public_id=$1 AND n.read_at IS NULL`, [crowdIncident.id]))[0].n, 100)
  ok('worker real SIGKILL tras reclamar; reinicio recupera cien avisos sin duplicados en menos de 30 s, todos sin leer')

  await incidents.command(operator, crowdIncident.id, command('update', 1, { instructions: 'Instrucciones actualizadas' }))
  await drain()
  const bothVersions = await events(crowdIncident.id)
  assert.equal(bothVersions.length, 200)
  assert.equal(bothVersions.filter(e => e.version === 1 && e.payload.incident.instructions === 'No consumir; contactar al establecimiento').length, 100)
  assert.equal(bothVersions.filter(e => e.version === 2 && e.payload.incident.instructions === 'Instrucciones actualizadas').length, 100)
  ok('la versión dos avisa de nuevo a cien personas y conserva intactas las instrucciones de la versión uno')

  const failedLot = await lot(1), failedIncident = await report(operator, failedLot)
  await incidents.command(operator, failedIncident.id, command())
  await query(`CREATE FUNCTION fail_k044_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_type='incident_version' THEN RAISE EXCEPTION 'fallo de prueba'; END IF; RETURN NEW; END $$`)
  await query('CREATE TRIGGER fail_k044_event BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_k044_event()')
  await assert.rejects(dispatcher.processNext(), /fallo de prueba/)
  assert.equal((await pending(failedIncident.id)).length, 1); assert.equal((await events(failedIncident.id)).length, 0)
  await query('DROP TRIGGER fail_k044_event ON outbox_events'); await query('DROP FUNCTION fail_k044_event()')
  await dispatcher.processNext()
  const failDelivery = createOutboxProcessor({ ...outbox, deliver: async () => { throw new Error('fallo al generar aviso') } }, now, () => 0.5)
  await failDelivery.processNext()
  let [event] = await events(failedIncident.id)
  assert.equal(event.status, 'pending'); assert.equal(event.attempts, 1); assert.ok(event.available_at > now())
  await query("UPDATE outbox_events SET available_at=now(),attempts=4 WHERE id=$1", [event.id])
  await failDelivery.processNext()
  ;[event] = await events(failedIncident.id)
  assert.equal(event.status, 'failed'); assert.equal(event.attempts, 5)
  assert.equal((await createOperations(pool, 5).readBacklog()).find(q => q.queue === 'notifications').failed, 1)
  // Operación reactiva el mismo evento; las dos entregas idempotentes no duplican el aviso.
  await query("UPDATE outbox_events SET status='pending',attempts=0,available_at=now() WHERE id=$1", [event.id])
  const [reclaimed] = await outbox.claim(50, now(), new Date(Date.now()+120000))
  await outbox.deliver(reclaimed, now()); await outbox.deliver(reclaimed, now())
  assert.equal((await query('SELECT count(*)::int n FROM notifications WHERE event_id=$1', [event.id]))[0].n, 1)
  ok('fallo de fan-out conserva el pendiente; entrega reintenta con espera, falla visible a cinco intentos y se reactiva sin duplicar')

  console.log(`PASS K044: ${checks} grupos con PostgreSQL real y worker reiniciado`)
} finally {
  await stopWorker('SIGKILL')
  await gateDb.query('ROLLBACK').catch(() => {})
  await gateDb.end(); await pool.end()
}
