// K047 · seguimiento después de entregar con PostgreSQL real y el worker real (RF11, RF09, RNF01).
// Cien destinatarios mixtos creados con los casos de uso: retiraron, reservan, cancelaron, tienen
// oferta, esperan o salieron de la cola, más dos operadores. Los chats de quienes retiraron o
// cancelaron ya cerraron, y los de quienes cancelaron también perdieron su texto por retención.
// El worker muere a mitad de los avisos y se reinicia; otra versión compite por el bloqueo del lote
// con reservas y retiros. Cada versión llega una vez a cada destinatario, con el worker sano en
// hasta 30 s, y E y la suma del inventario se conservan en cada etapa.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
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
import { createChatRepository } from '../dist/infrastructure/postgres/chat-repository.js'
import { createChatUseCases } from '../dist/application/chat/use-cases.js'
import { createPickupCodes } from '../dist/infrastructure/crypto/pickup-codes.js'
import { createOutboxRepository } from '../dist/infrastructure/postgres/notification-repository.js'
import { createOutboxProcessor } from '../dist/application/notifications/use-cases.js'
import { createOperations } from '../dist/infrastructure/postgres/operations.js'
import { OUTBOX_LEASE_MS } from '../dist/domain/notifications.js'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_k047_test_/.test(new URL(connectionString).pathname.slice(1)), 'Solo base dedicada K047')
// Holgura para que las veinte operaciones de la carrera esperen el bloqueo a la vez.
const pool = createPool({ connectionString, max: 24 }), gateDb = new pg.Client({ connectionString })
const codes = createPickupCodes(randomBytes(32)), now = () => new Date()
const repository = createIncidentRepository(pool), incidents = createIncidentUseCases(repository)
const dispatcher = createIncidentDispatcher(createIncidentDispatchRepository(pool))
const processor = createOutboxProcessor(createOutboxRepository(pool), now)
const reservations = createReservationUseCases(createReservationRepository(pool), codes, now)
const discovery = createDiscoveryUseCases(createDiscoveryRepository(pool), codes, now)
const waitlist = createWaitlistUseCases(createWaitlistRepository(pool), codes, now)
const chat = createChatUseCases(createChatRepository(pool), now)
const query = async (sql, values) => (await pool.query(sql, values)).rows
const count = async (sql, values) => (await query(sql, values))[0].n
const people = async n => (await query(`INSERT INTO users(email) SELECT 'k047-'||gen_random_uuid()||'@example.invalid'
  FROM generate_series(1,$1) RETURNING id::text AS "userId"`, [n]))
const GOAL_MS = 30_000
const INSTRUCTIONS = ['No consumir los packs; contactar al establecimiento', 'Devolver el envase en el local', 'El lote quedó cerrado']
const command = (action, version, instructions, extra = {}) => ({ action, version, reason: 'Contaminación detectada en el lote',
  instructions, idempotencyKey: randomUUID(), ...extra })
const deliver = (actor, lot, reservation, code) => reservations.confirmPickup(actor, lot, reservation, code, randomUUID(), () => {})
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function until(predicate, label, timeout = 1500) {
  const start = Date.now()
  while (!await predicate()) {
    assert.ok(Date.now() - start < timeout, `Tiempo agotado: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return Date.now() - start
}

// E se respalda con las entregas registradas y la suma F+O+R+E+X es siempre la cantidad del lote.
async function inventory(lot, expected) {
  const [row] = await query(`SELECT quantity,free_quantity f,offered_quantity o,reserved_quantity r,delivered_quantity e,
    expired_quantity x,(SELECT coalesce(sum(d.quantity),0)::int FROM deliveries d JOIN commitments c ON c.id=d.commitment_id
      WHERE c.lot_id=l.id) delivered FROM lots l WHERE public_id=$1`, [lot])
  assert.equal(row.f + row.o + row.r + row.e + row.x, row.quantity, 'F+O+R+E+X es la cantidad del lote')
  assert.equal(row.e, row.delivered, 'E coincide con las entregas registradas')
  assert.deepEqual({ f: row.f, o: row.o, r: row.r, e: row.e, x: row.x }, expected)
}
const recipients = (incident, version) => query(`SELECT r.user_id::text AS "userId", r.relation, r.outbox_event_id
  FROM incident_recipients r JOIN incidents i ON i.id=r.incident_id WHERE i.public_id=$1 AND r.version=$2`, [incident, version])
const notices = (incident, version) => query(`SELECT n.user_id::text AS "userId", n.payload FROM notifications n
  JOIN outbox_events e ON e.id=n.event_id JOIN incidents i ON i.id=e.subject_id
  WHERE e.event_type='incident_version' AND i.public_id=$1 AND e.version=$2`, [incident, version])
const noticeCount = (incident, version) => count(`SELECT count(*)::int n FROM notifications n JOIN outbox_events e ON e.id=n.event_id
  JOIN incidents i ON i.id=e.subject_id WHERE e.event_type='incident_version' AND i.public_id=$1 AND e.version=$2`, [incident, version])
const drain = async () => {
  while (await dispatcher.processNext()) {}
  while (await processor.processNext()) {}
}

/** Un aviso por destinatario de la versión, con la relación fijada y sin códigos ni texto del chat. */
async function assertDelivered(incident, version, instructions, forbidden) {
  const fixed = await recipients(incident, version), sent = await notices(incident, version)
  assert.equal(new Set(sent.map(n => n.userId)).size, sent.length, `versión ${version}: ningún aviso duplicado`)
  assert.deepEqual(sent.map(n => n.userId).sort(), fixed.map(r => r.userId).sort(), `versión ${version}: todos los destinatarios`)
  const relation = new Map(fixed.map(r => [r.userId, r.relation]))
  for (const { userId, payload } of sent) {
    assert.equal(payload.incident.version, version); assert.equal(payload.incident.instructions, instructions)
    assert.equal(payload.incident.relation, relation.get(userId))
  }
  const text = JSON.stringify(sent)
  for (const value of forbidden) assert.ok(!text.includes(value), 'el aviso no lleva códigos ni texto del chat')
  assert.equal(await count(`SELECT count(*)::int n FROM (SELECT 1 FROM outbox_events WHERE event_type='incident_version'
    GROUP BY subject_id,version,recipient_user_id HAVING count(*)>1) d`), 0, 'un evento por incidencia, versión y persona')
  return fixed
}

let worker
const workerErrors = []
const startWorker = () => {
  worker = spawn(process.execPath, ['dist/worker.js'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env,
    DATABASE_URL: connectionString, WORKER_EXPIRIES: 'off', PHOTO_STORAGE: '' } })
  // Solo se guardan los códigos de error; el registro del worker no lleva SQL ni datos personales.
  createInterface({ input: worker.stdout }).on('line', line => {
    try {
      const event = JSON.parse(line)
      if (['worker_error', 'outbox_event_failed', 'database_idle_connection_lost'].includes(event.event)) workerErrors.push(event)
    } catch {}
  })
  return worker
}
// Si la prueba termina sin pasar por finally, el worker no queda huérfano.
process.once('exit', () => worker?.kill('SIGKILL'))
const stopWorker = async signal => {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return
  const ended = new Promise(resolve => worker.once('exit', resolve))
  worker.kill(signal)
  await ended
}
let checks = 0
const ok = label => console.log(`OK K047 ${++checks}: ${label}`)

try {
  await gateDb.connect()
  // 1. Cien destinatarios mixtos sobre un lote de 60 packs.
  const [operatorA, operatorB, outsider] = await people(3)
  const est = (await query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('K047','Santiago',-33.45,-70.66,'America/Santiago') RETURNING id::text`))[0].id
  await query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$3),($2,$3)', [operatorA.userId, operatorB.userId, est])
  const lot = (await query(`INSERT INTO lots(establishment_id,description,category,quantity,address,latitude,longitude,time_zone,
    pickup_starts_at,pickup_ends_at,status,published_at) VALUES ($1,'Lote K047','Prueba',60,'Santiago',-33.45,-70.66,
    'America/Santiago',now()-interval '1 hour',now()+interval '3 hours','published',now()) RETURNING public_id::text AS id`, [est]))[0].id
  const operators = [operatorA, operatorB], operatorOf = i => operators[i % 2]
  const [received, active, cancelled, queued] = await Promise.all([people(20), people(20), people(20), people(38)])
  const secrets = [], held = new Map()
  const reserveAndWrite = async holder => {
    const reservation = await discovery.reserve(holder, lot, 1, randomUUID())
    const code = (await reservations.get(holder, reservation.id)).pickupCode, text = `k047-chat-${randomUUID()}`
    await chat.send(holder, reservation.id, text, randomUUID())
    secrets.push(code, text); held.set(holder.userId, { id: reservation.id, code })
    return reservation.id
  }
  for (const [i, holder] of received.entries()) {
    const id = await reserveAndWrite(holder)
    await deliver(operatorOf(i), lot, id, held.get(holder.userId).code)
  }
  for (const holder of [...active, ...cancelled]) await reserveAndWrite(holder)
  await inventory(lot, { f: 0, o: 0, r: 40, e: 20, x: 0 })
  const entries = []
  for (const person of queued) entries.push(await waitlist.join(person, lot, 1, randomUUID()))
  assert.ok(entries.every(entry => entry.status === 'waiting'))
  for (const [i, entry] of entries.slice(-5).entries()) await waitlist.leave(queued[33 + i], entry.id)
  // Cancelar libera 20 packs que la cola FIFO ofrece a las primeras veinte solicitudes.
  for (const holder of cancelled) await reservations.cancel(holder, held.get(holder.userId).id)
  await inventory(lot, { f: 0, o: 20, r: 20, e: 20, x: 0 })
  const states = await Promise.all(entries.map((entry, i) => waitlist.get(queued[i], entry.id)))
  assert.deepEqual(states.map(s => s.status), [...Array(20).fill('offered'), ...Array(13).fill('waiting'), ...Array(5).fill('left')])
  for (const holder of [...received, ...cancelled]) {
    await assert.rejects(chat.send(holder, held.get(holder.userId).id, 'k047-cerrado', randomUUID()), { reason: 'closed' })
  }
  assert.ok((await chat.list(active[0], held.get(active[0].userId).id, 0)).open)
  // Retención: las conversaciones de quienes cancelaron cerraron hace 31 días; el worker borrará su texto.
  await query(`UPDATE commitments SET ended_at=ended_at-interval '31 days' WHERE user_id=ANY($1::bigint[])`,
    [cancelled.map(p => p.userId)])
  await drain()
  ok('cien destinatarios mixtos con casos de uso reales: 20 E, 20 R, 20 cancelados, 20 O, 13 en espera, 5 salieron y 2 operadores; chats cerrados')

  // 2. Versión 1 sin cierre: fija cien destinatarios y no toca el inventario.
  const incident = await incidents.report(received[0], lot, { reason: 'Un pack llegó en mal estado', idempotencyKey: randomUUID() })
  await incidents.command(operatorA, incident.id, command('publish', 0, INSTRUCTIONS[0]))
  const v1 = await recipients(incident.id, 1)
  assert.equal(v1.length, 100)
  const relations = v1.reduce((all, r) => ({ ...all, [r.relation]: (all[r.relation] ?? 0) + 1 }), {})
  assert.deepEqual(relations, { received: 20, committed: 78, operator: 2 })
  assert.ok(received.every(p => v1.find(r => r.userId === p.userId).relation === 'received'))
  await inventory(lot, { f: 0, o: 20, r: 20, e: 20, x: 0 })
  ok('versión 1 fija 100 destinatarios (20 received, 78 committed, 2 operator) sin cambiar inventario')

  // 3. El worker real muere con 30 de 100 avisos generados y 20 eventos reclamados.
  await gateDb.query('BEGIN'); await gateDb.query('SELECT pg_advisory_xact_lock(470047)')
  await query(`CREATE FUNCTION block_k047_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.kind='incident_version' AND (SELECT count(*) FROM notifications WHERE kind='incident_version') >= 30
    THEN PERFORM pg_advisory_xact_lock(470047); END IF; RETURN NEW; END $$`)
  await query('CREATE TRIGGER block_k047_notice BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION block_k047_notice()')
  startWorker()
  await until(async () => await count(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database()
    AND wait_event_type='Lock' AND wait_event='advisory'`) === 1, 'el worker se detiene en el aviso 31', 15000)
  await stopWorker('SIGKILL')
  // La conexión del proceso muerto se cierra antes de liberar la compuerta: su aviso 31 no se confirma.
  await query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database()
    AND wait_event_type='Lock' AND wait_event='advisory'`)
  await gateDb.query('COMMIT')
  await query('DROP TRIGGER block_k047_notice ON notifications'); await query('DROP FUNCTION block_k047_notice()')
  assert.equal(await noticeCount(incident.id, 1), 30)
  assert.equal((await recipients(incident.id, 1)).filter(r => r.outbox_event_id === null).length, 50)
  const leased = `SELECT count(*)::int n FROM outbox_events WHERE event_type='incident_version' AND status='pending'
    AND claimed_until > now()`
  assert.equal(await count(leased), 20)
  const leaseEnds = (await query(`SELECT max(claimed_until) AS at FROM outbox_events WHERE event_type='incident_version'`))[0].at
  const restartedAt = Date.now()
  startWorker()
  const unleasedMs = await until(async () => await noticeCount(incident.id, 1) === 80, 'el reinicio avisa a los 50 sin evento', GOAL_MS)
  assert.equal(await count(leased), 20, 'los eventos reclamados por el worker muerto esperan su concesión')
  const recoveredMs = await until(async () => await noticeCount(incident.id, 1) === 100, 'la concesión vence y se completan los avisos',
    leaseEnds.getTime() - Date.now() + GOAL_MS)
  await assertDelivered(incident.id, 1, INSTRUCTIONS[0], secrets)
  await inventory(lot, { f: 0, o: 20, r: 20, e: 20, x: 0 })
  ok(`SIGKILL con 30/100 avisos: el reinicio genera 50 más en ${unleasedMs} ms y los 20 reclamados al vencer la concesión de `
    + `${OUTBOX_LEASE_MS / 1000} s (${Math.round((Date.now() - restartedAt) / 1000)} s en total, ${recoveredMs} ms tras los 80); `
    + 'cien avisos únicos, E y suma intactos')

  const erased = await query(`SELECT c.user_id::text AS "userId", m.body FROM chat_messages m JOIN commitments c ON c.id=m.commitment_id
    WHERE c.user_id=ANY($1::bigint[])`, [[...received, ...cancelled].map(p => p.userId)])
  const cancelledIds = new Set(cancelled.map(p => p.userId))
  assert.equal(erased.length, 40)
  assert.ok(erased.every(m => cancelledIds.has(m.userId) ? m.body === null : m.body !== null))
  const ownNotice = (await notices(incident.id, 1)).find(n => n.userId === cancelled[0].userId)
  assert.equal(ownNotice.payload.incident.instructions, INSTRUCTIONS[0])
  ok('el worker reiniciado borra el texto de los chats vencidos; quien canceló conserva sus instrucciones')

  // 4. Worker sano: la versión 2 retiene el bloqueo del lote mientras 10 reservas nuevas y 10 retiros lo esperan.
  // Cada retiro usa su propio operador: el cupo de códigos se bloquea por operador antes que el lote.
  for (const [i, entry] of entries.slice(20, 33).entries()) await waitlist.leave(queued[20 + i], entry.id)
  for (const [i, entry] of entries.slice(0, 10).entries()) await waitlist.decline(queued[i], entry.id)
  await inventory(lot, { f: 10, o: 10, r: 20, e: 20, x: 0 })
  const newcomers = await people(10), pickedUp = active.slice(0, 10), desk = [operatorA, operatorB, ...await people(8)]
  await query(`INSERT INTO memberships(user_id,establishment_id) SELECT unnest($1::bigint[]),$2`, [desk.slice(2).map(p => p.userId), est])
  await Promise.all(Array.from({ length: 22 }, () => pool.query('SELECT 1')))
  const entered = deferred(), release = deferred()
  const heldIncidents = createIncidentUseCases({ ...repository,
    withCommand: (user, id, key, operate) => repository.withCommand(user, id, key, (state, writer) => operate(state, {
      ...writer, publish: async (...args) => { const value = await writer.publish(...args); entered.resolve(); await release.promise; return value },
    })),
  })
  const v2 = heldIncidents.command(operatorB, incident.id, command('update', 1, INSTRUCTIONS[1]))
  // Un fallo antes de publicar no deja la espera colgada: termina la prueba por finally.
  await Promise.race([entered.promise, v2.then(() => { throw new Error('la versión 2 terminó sin retener el lote') })])
  const racing = [
    ...newcomers.map(person => discovery.reserve(person, lot, 1, randomUUID())),
    ...pickedUp.map((holder, i) => deliver(desk[i], lot, held.get(holder.userId).id, held.get(holder.userId).code)),
  ].map(operation => operation.then(value => ({ value }), error => ({ error })))
  // El bloqueo del lote espera como máximo 2 s; se libera apenas las veinte operaciones lo esperan.
  try {
    await until(async () => await count(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND query LIKE '%FROM public.lots WHERE public_id%'`) === 20, '20 operaciones esperan el lote')
  } finally { release.resolve() }
  const releasedAt = Date.now()
  await v2
  const outcomes = await Promise.all(racing)
  assert.deepEqual(outcomes.filter(o => o.error).map(o => o.error.message), [], 'reservas y retiros concurrentes se confirman')
  for (const [i, { value }] of outcomes.slice(0, 10).entries()) secrets.push((await reservations.get(newcomers[i], value.id)).pickupCode)
  await inventory(lot, { f: 0, o: 10, r: 20, e: 30, x: 0 })
  await until(async () => await noticeCount(incident.id, 2) === 118, 'la versión 2 llega a 118 personas', GOAL_MS)
  const v2Ms = Date.now() - releasedAt
  const v2Fixed = await assertDelivered(incident.id, 2, INSTRUCTIONS[1], secrets)
  const relationOf = new Map(v2Fixed.map(r => [r.userId, r.relation]))
  assert.ok(newcomers.every(p => relationOf.get(p.userId) === 'committed'), 'quien reservó después se incorpora a la versión vigente')
  assert.ok(pickedUp.every(p => relationOf.get(p.userId) === 'committed'), 'la relación queda fijada antes del retiro')
  assert.ok(received.every(p => relationOf.get(p.userId) === 'received'))
  assert.ok(desk.every(p => relationOf.get(p.userId) === 'operator'), 'los operadores actuales se incorporan')
  assert.equal((await recipients(incident.id, 1)).length, 100, 'la versión 1 no incorpora a quien llegó después')
  assert.equal(await noticeCount(incident.id, 1), 100)
  assert.ok(v2Ms < GOAL_MS)
  ok(`versión 2 retiene el lote con 10 reservas y 10 retiros esperando: 118 avisos únicos en ${v2Ms} ms `
    + `desde la liberación (meta ${GOAL_MS / 1000} s); E pasa a 30 por los retiros y la suma se conserva`)

  // 5. Worker sano: la versión 3 cierra el lote; conserva E y avisa a todos de nuevo.
  const closeStarted = Date.now()
  const v3 = await incidents.command(operatorA, incident.id, command('update', 2, INSTRUCTIONS[2], { closeLot: true }))
  assert.equal(v3.lotClosed, true)
  await inventory(lot, { f: 0, o: 0, r: 0, e: 30, x: 30 })
  const v3Ms = await until(async () => await noticeCount(incident.id, 3) === 118, 'la versión 3 llega a 118 personas', GOAL_MS)
  const v3Relation = new Map((await assertDelivered(incident.id, 3, INSTRUCTIONS[2], secrets)).map(r => [r.userId, r.relation]))
  // Seguimiento después de entregar: quien retiró tras la versión 2 figura como received en la 3.
  assert.ok([...received, ...pickedUp].every(p => v3Relation.get(p.userId) === 'received'))
  assert.ok(newcomers.every(p => v3Relation.get(p.userId) === 'committed'))
  assert.ok(desk.every(p => v3Relation.get(p.userId) === 'operator'))
  await assert.rejects(chat.send(newcomers[0], outcomes[0].value.id, 'k047-cerrado', randomUUID()), { reason: 'closed' })
  await assert.rejects(discovery.reserve(outsider, lot, 1, randomUUID()), { code: 'lot_not_found' })
  await inventory(lot, { f: 0, o: 0, r: 0, e: 30, x: 30 })
  ok(`versión 3 con cierre: F/O/R pasan a X, E=30 y la suma se conservan; quien retiró pasa a received; 118 avisos únicos en ${v3Ms} ms `
    + `(${Date.now() - closeStarted} ms desde el comando)`)

  await stopWorker('SIGTERM')
  const [backlog] = (await createOperations(pool, 5).readBacklog()).filter(q => q.queue === 'notifications')
  assert.equal(backlog.pending, 0); assert.equal(backlog.failed, 0)
  assert.equal(await count(`SELECT count(*)::int n FROM incident_recipients WHERE outbox_event_id IS NULL`), 0)
  assert.equal(await count(`SELECT count(*)::int n FROM notifications WHERE kind='incident_version' AND read_at IS NOT NULL`), 0)
  assert.deepEqual(workerErrors, [], 'el worker no registró errores de ciclo, de entrega ni de conexión')
  // Solo los 20 eventos que reclamó el worker muerto necesitaron un segundo intento.
  assert.deepEqual(await query(`SELECT attempts, count(*)::int n FROM outbox_events WHERE event_type='incident_version'
    GROUP BY attempts ORDER BY attempts`), [{ attempts: 1, n: 316 }, { attempts: 2, n: 20 }])
  ok('336 avisos de tres versiones, sin pendientes ni fallos en operación, sin lecturas automáticas ni errores del worker; '
    + 'solo los 20 eventos del worker muerto se reintentaron')

  console.log(`PASS K047: ${checks} grupos con PostgreSQL real y worker real reiniciado`)
} finally {
  await stopWorker('SIGKILL')
  await gateDb.query('ROLLBACK').catch(() => {})
  await gateDb.end(); await pool.end()
}
