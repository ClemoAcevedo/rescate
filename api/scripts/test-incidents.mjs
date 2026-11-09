// K043: reportes, versiones y destinatarios con PostgreSQL real y contrato HTTP.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { createApi } from '../dist/composition.js'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createIncidentRepository } from '../dist/infrastructure/postgres/incident-repository.js'
import { createIncidentUseCases } from '../dist/application/incidents/use-cases.js'
import { createDiscoveryRepository } from '../dist/infrastructure/postgres/discovery-repository.js'
import { createDiscoveryUseCases } from '../dist/application/discovery/use-cases.js'
import { createReservationRepository } from '../dist/infrastructure/postgres/reservation-repository.js'
import { createReservationUseCases } from '../dist/application/reservations/use-cases.js'
import { createWaitlistRepository } from '../dist/infrastructure/postgres/waitlist-repository.js'
import { createWaitlistUseCases } from '../dist/application/waitlist/use-cases.js'
import { createLotManagementRepository } from '../dist/infrastructure/postgres/lot-management-repository.js'
import { createLotManagement } from '../dist/application/lots/management.js'
import { createPickupCodes } from '../dist/infrastructure/crypto/pickup-codes.js'
import { assertContract } from '../test/support/openapi.ts'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_k043_test_/.test(new URL(connectionString).pathname.slice(1)), 'Solo base dedicada K043')
const pickupKey = randomBytes(32)
const db = new pg.Client({ connectionString })
const pool = createPool({ connectionString })
const api = createApi({ DATABASE_URL: connectionString, RESCATE_ALLOWED_ORIGINS: 'https://localhost:5173',
  CSRF_SIGNING_KEY: randomBytes(32).toString('base64'), PICKUP_CODE_KEY: pickupKey.toString('base64') }, () => {})
const server = api.app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`

function client() {
  let csrf = ''; const cookies = new Map()
  return async function call(method, path, body, overrides = {}, retry = 0) {
    const response = await fetch(base + path, { method, headers: {
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET' ? {} : { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf }), ...overrides,
    }, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const line of response.headers.getSetCookie()) { const pair = line.split(';')[0]; const at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1)) }
    const result = await response.json(); if (result.csrfToken) csrf = result.csrfToken
    assertContract(method, path, response, result)
    if (response.status === 429 && retry < 3) {
      await new Promise(resolve => setTimeout(resolve, Number(response.headers.get('retry-after')) * 1000))
      return call(method, path, body, overrides, retry + 1)
    }
    return { status: response.status, body: result }
  }
}

let count = 0
const ok = label => console.log(`OK K043 ${++count}: ${label}`)
const now = () => new Date()
const codes = createPickupCodes(pickupKey)
const incidents = createIncidentUseCases(createIncidentRepository(pool))
const discovery = createDiscoveryUseCases(createDiscoveryRepository(pool), codes, now)
const reservations = createReservationUseCases(createReservationRepository(pool), codes, now)
const waitlist = createWaitlistUseCases(createWaitlistRepository(pool), codes, now)
const management = createLotManagement(createLotManagementRepository(pool))

try {
  await db.connect()
  async function person() {
    const call = client(), email = `k043-${randomUUID()}@example.invalid`, password = 'Clave-segura-k043-fixture'
    await call('GET', '/auth/session')
    assert.equal((await call('POST', '/auth/register', { email, password, privacyConsent: true })).status, 201)
    assert.equal((await call('POST', '/auth/login', { email, password })).status, 200)
    return { call, userId: (await db.query('SELECT id::text FROM users WHERE email=$1', [email])).rows[0].id }
  }
  const seeded = async () => ({ userId: (await pool.query('INSERT INTO users(email) VALUES ($1) RETURNING id::text',
    [`k043-${randomUUID()}@example.invalid`])).rows[0].id })
  const establishment = async () => (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('K043','Santiago',-33.45,-70.66,'America/Santiago') RETURNING id::text`)).rows[0].id
  const join = (actor, est) => db.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)', [actor.userId, est])
  const makeLot = async (est, quantity) => (await db.query(`INSERT INTO lots(establishment_id,description,category,quantity,
    address,latitude,longitude,time_zone,pickup_starts_at,pickup_ends_at,status,published_at)
    VALUES ($1,'Empanadas de prueba','K043',$2,'Santiago',-33.45,-70.66,'America/Santiago',now()-interval '1 hour',
      now()+interval '2 hours','published',now()) RETURNING public_id::text AS id`, [est, quantity])).rows[0].id
  const reserve = (actor, lot) => discovery.reserve(actor, lot, 1, randomUUID())
  const enqueue = (actor, lot) => waitlist.join(actor, lot, 1, randomUUID())
  const reason = 'Se detectó un problema de refrigeración'
  const instructions = 'No consumir y conservar el envase'
  const report = (actor, lot) => incidents.report(actor, lot, { reason, idempotencyKey: randomUUID() })
  const command = (action, version, extra = {}) => ({ action, version, reason, instructions, idempotencyKey: randomUUID(), ...extra })
  const recipients = async (incident, version) => Object.fromEntries((await db.query(
    `SELECT r.user_id::text, r.relation FROM incident_recipients r JOIN incidents i ON i.id = r.incident_id
     WHERE i.public_id = $1 AND r.version = $2`, [incident, version])).rows.map(row => [row.user_id, row.relation]))
  const lotState = async lot => (await db.query(`SELECT l.status, l.version, l.free_quantity, l.offered_quantity, l.reserved_quantity,
    l.delivered_quantity, l.expired_quantity, l.closed_at,
    (SELECT json_agg(json_build_object('id', c.id, 'status', c.status, 'code', c.pickup_code_ciphertext IS NOT NULL) ORDER BY c.id)
       FROM commitments c WHERE c.lot_id = l.id) AS commitments,
    (SELECT json_agg(json_build_object('id', w.id, 'status', w.status) ORDER BY w.id) FROM waitlist_entries w WHERE w.lot_id = l.id) AS entries
    FROM lots l WHERE l.public_id = $1`, [lot])).rows[0]
  const outboxCount = async () => (await db.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n

  const est = await establishment(), otherEst = await establishment()
  const operator = await person(), holder = await person(), stranger = await person(), otherOperator = await person()
  await join(operator, est); await join(otherOperator, otherEst)

  // Permisos, formato y contrato por HTTP real.
  const lot = await makeLot(est, 3), path = `/lots/${lot}/incidents`
  await reserve(holder, lot)
  const body = (extra = {}) => ({ reason, idempotencyKey: randomUUID(), ...extra })
  assert.equal((await client()('GET', path)).status, 401)
  assert.equal((await stranger.call('GET', path)).status, 403)
  assert.equal((await stranger.call('POST', path, body())).status, 404)
  assert.equal((await holder.call('POST', `/lots/${randomUUID()}/incidents`, body())).status, 404)
  assert.equal((await holder.call('POST', '/lots/no-uuid/incidents', body())).status, 404)
  assert.equal((await holder.call('POST', path, body(), { 'X-CSRF-Token': 'incorrecto' })).status, 403)
  assert.equal((await holder.call('POST', path, body({ reason: '   ' }))).status, 422)
  assert.equal((await holder.call('POST', path, body({ reason: 'x'.repeat(2001) }))).status, 422)
  assert.equal((await holder.call('POST', path, body({ extra: true }))).status, 422)
  assert.equal((await holder.call('POST', path, body(), { 'Content-Type': 'text/plain' })).status, 415)
  ok('sesión, acceso al lote, CSRF, tipo de contenido y límites de texto comprobados por HTTP')

  // Un reporte no tiene efectos y su reintento no duplica.
  const beforeReport = await lotState(lot), outboxBefore = await outboxCount()
  const intent = body()
  const reported = await holder.call('POST', path, intent)
  assert.equal(reported.status, 201)
  assert.deepEqual((await holder.call('POST', path, intent)).body, reported.body)
  assert.equal((await holder.call('POST', path, { ...intent, reason: 'Otro motivo' })).status, 409)
  assert.deepEqual(await lotState(lot), beforeReport)
  assert.equal(await outboxCount(), outboxBefore)
  assert.deepEqual(await recipients(reported.body.id, 1), {})
  const listed = await operator.call('GET', path)
  assert.equal(listed.status, 200); assert.equal(listed.body.items.length, 1)
  assert.equal(listed.body.items[0].status, 'reported'); assert.deepEqual(listed.body.items[0].versions, [])
  ok('el reporte no cancela, no cierra, no avisa ni fija destinatarios; la misma clave reproduce el resultado')

  // Autorización y transiciones de una versión.
  const incident = reported.body.id, versions = `/incidents/${incident}/versions`
  assert.equal((await stranger.call('POST', versions, command('publish', 0))).status, 404)
  assert.equal((await holder.call('POST', versions, command('publish', 0))).status, 404)
  assert.equal((await otherOperator.call('POST', versions, command('publish', 0))).status, 404)
  assert.equal((await operator.call('POST', `/incidents/${randomUUID()}/versions`, command('publish', 0))).status, 404)
  assert.equal((await operator.call('POST', '/incidents/no-uuid/versions', command('publish', 0))).status, 404)
  assert.equal((await operator.call('POST', versions, command('publish', 1))).status, 409)
  assert.equal((await operator.call('POST', versions, command('update', 0))).status, 409)
  assert.equal((await operator.call('POST', versions, command('resolve', 0))).status, 409)
  assert.equal((await operator.call('POST', versions, command('publish', 0, { instructions: ' ' }))).status, 422)
  assert.equal((await operator.call('POST', versions, command('close', 0))).status, 422)
  assert.equal((await db.query('SELECT count(*)::int n FROM incident_versions')).rows[0].n, 0)
  ok('solo un operador miembro publica; incidencia ajena e inexistente son indistinguibles; se exige versión y transición válidas')

  const beforePublish = await lotState(lot)
  const publication = command('publish', 0)
  const published = await operator.call('POST', versions, publication)
  assert.equal(published.status, 201); assert.equal(published.body.status, 'open'); assert.equal(published.body.version, 1)
  assert.deepEqual((await operator.call('POST', versions, publication)).body, published.body)
  assert.equal((await operator.call('POST', versions, { ...publication, reason: 'Otro' })).status, 409)
  const updated = await operator.call('POST', versions, command('update', 1))
  assert.equal(updated.body.status, 'following'); assert.equal(updated.body.version, 2)
  assert.deepEqual((await operator.call('POST', versions, publication)).body, published.body)
  const followed = await operator.call('POST', versions, command('update', 2))
  assert.equal(followed.body.status, 'following'); assert.equal(followed.body.version, 3)
  assert.equal((await operator.call('POST', versions, command('publish', 3))).status, 409)
  const resolved = await operator.call('POST', versions, command('resolve', 3))
  assert.equal(resolved.body.status, 'resolved'); assert.equal(resolved.body.version, 4)
  assert.equal((await operator.call('POST', versions, command('update', 4))).status, 409)
  assert.equal((await operator.call('POST', versions, command('resolve', 4))).status, 409)
  assert.deepEqual(await lotState(lot), beforePublish)
  const history = (await operator.call('GET', path)).body.items[0]
  assert.deepEqual(history.versions.map(version => [version.version, version.status]),
    [[1, 'open'], [2, 'following'], [3, 'following'], [4, 'resolved']])
  assert.equal(history.status, 'resolved'); assert.equal(history.versions[0].recipientCount, 2)
  ok('abierta, en seguimiento y resuelta conservan versiones; el reintento devuelve el original; resolver no toca lote ni códigos')

  // Conjunto de destinatarios con todos los compromisos históricos.
  const mixed = await makeLot(est, 4)
  const [received, active, expired, cancelled, offered, waiting, left, alsoOperator, onlyOperator, outsider] =
    await Promise.all(Array.from({ length: 10 }, seeded))
  await join(alsoOperator, est); await join(onlyOperator, est)
  // Cancelar y volver a reservar deja dos compromisos: sigue siendo una sola persona.
  const first = await reserve(received, mixed)
  await reservations.cancel(received, first.id)
  const delivered = await reserve(received, mixed)
  await reserve(active, mixed)
  const lapsing = await reserve(expired, mixed)
  const releasing = await reserve(cancelled, mixed)
  await enqueue(offered, mixed); const queued = await enqueue(waiting, mixed)
  const leaving = await enqueue(left, mixed)
  await waitlist.leave(left, leaving.id)
  await enqueue(alsoOperator, mixed)
  await reservations.cancel(cancelled, releasing.id)
  const offeredStatus = await db.query(`SELECT count(*)::int n FROM waitlist_entries w JOIN lots l ON l.id = w.lot_id
    WHERE l.public_id = $1 AND w.status = 'offered' AND w.user_id = $2`, [mixed, offered.userId])
  assert.equal(offeredStatus.rows[0].n, 1)
  assert.equal((await waitlist.get(waiting, queued.id)).status, 'waiting')
  const code = (await reservations.get(received, delivered.id)).pickupCode
  await reservations.confirmPickup(operator, mixed, delivered.id, code, randomUUID(), () => undefined)
  await db.query(`UPDATE commitments SET status='expired', ended_at=now(), pickup_code_ciphertext=NULL WHERE public_id=$1`, [lapsing.id])
  const mixedIncident = await report(active, mixed)
  await incidents.command(operator, mixedIncident.id, command('publish', 0))
  assert.deepEqual(await recipients(mixedIncident.id, 1), {
    [received.userId]: 'received', [active.userId]: 'committed', [expired.userId]: 'committed', [cancelled.userId]: 'committed',
    [offered.userId]: 'committed', [waiting.userId]: 'committed', [left.userId]: 'committed', [alsoOperator.userId]: 'committed',
    [onlyOperator.userId]: 'operator', [operator.userId]: 'operator',
  })
  assert.ok(!(outsider.userId in await recipients(mixedIncident.id, 1)))
  await assert.rejects(db.query(`INSERT INTO incident_recipients(incident_id,version,user_id,relation,created_at)
    SELECT id,1,$2,'committed',now() FROM incidents WHERE public_id=$1`, [mixedIncident.id, active.userId]), error => error.code === '23505')
  ok('espera, oferta, reserva activa, cancelada, vencida, retirada y salida de la cola quedan fijadas, una vez por persona, y distinguen quién recibió packs')

  // Incorporación a avisos vigentes y destinatarios históricos.
  const late = await makeLot(est, 3), former = await seeded(), [joiner, afterResolved] = await Promise.all([seeded(), seeded()])
  await join(former, est)
  const lateIncident = await report(operator, late)
  await incidents.command(operator, lateIncident.id, command('publish', 0))
  assert.equal((await recipients(lateIncident.id, 1))[former.userId], 'operator')
  await db.query('DELETE FROM memberships WHERE user_id=$1', [former.userId])
  await incidents.command(operator, lateIncident.id, command('update', 1))
  assert.equal((await recipients(lateIncident.id, 2))[former.userId], 'operator')
  const key = randomUUID()
  await discovery.reserve(joiner, late, 1, key); await discovery.reserve(joiner, late, 1, key)
  assert.equal((await recipients(lateIncident.id, 2))[joiner.userId], 'committed')
  assert.equal((await recipients(lateIncident.id, 1))[joiner.userId], undefined)
  await incidents.command(operator, lateIncident.id, command('resolve', 2))
  assert.equal((await recipients(lateIncident.id, 3))[joiner.userId], 'committed')
  await reserve(afterResolved, late)
  assert.equal((await recipients(lateIncident.id, 3))[afterResolved.userId], undefined)
  const full = await makeLot(est, 1), [first1, queuing] = await Promise.all([seeded(), seeded()])
  const fullIncident = await report(operator, full)
  await incidents.command(operator, fullIncident.id, command('publish', 0))
  await reserve(first1, full); await enqueue(queuing, full)
  assert.deepEqual(await recipients(fullIncident.id, 1),
    { [operator.userId]: 'operator', [alsoOperator.userId]: 'operator', [onlyOperator.userId]: 'operator', [first1.userId]: 'committed', [queuing.userId]: 'committed' })
  ok('reserva y entrada a la cola se suman a la última versión vigente; una incidencia resuelta no incorpora; se conservan destinatarios históricos')

  // Carrera entre publicar y comprometerse: bloqueos observados y todos los órdenes.
  const held = await makeLot(est, 1), raced = await seeded(), heldIncident = await report(operator, held)
  await db.query('BEGIN')
  await db.query('SELECT id FROM lots WHERE public_id=$1 FOR UPDATE', [held])
  const racing = [incidents.command(operator, heldIncident.id, command('publish', 0)), reserve(raced, held)]
  let blocked = 0
  for (let i = 0; i < 100 && blocked < 2; i++) {
    blocked = (await pool.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND query LIKE '%FROM public.lots WHERE public_id%'`)).rows[0].n
    if (blocked < 2) await new Promise(resolve => setTimeout(resolve, 10))
  }
  await db.query('COMMIT')
  await Promise.all(racing)
  assert.ok(blocked >= 2, 'publicar y reservar esperaron el mismo bloqueo')
  assert.equal((await recipients(heldIncident.id, 1))[raced.userId], 'committed')
  const crowded = await makeLot(est, 20), crowd = await Promise.all(Array.from({ length: 20 }, seeded))
  const crowdedIncident = await report(operator, crowded)
  await Promise.all([...crowd.slice(0, 10).map(actor => reserve(actor, crowded)),
    incidents.command(operator, crowdedIncident.id, command('publish', 0)),
    ...crowd.slice(10).map(actor => reserve(actor, crowded))])
  const crowdRows = (await db.query(`SELECT r.user_id::text, count(*)::int n FROM incident_recipients r
    JOIN incidents i ON i.id=r.incident_id WHERE i.public_id=$1 GROUP BY r.user_id`, [crowdedIncident.id])).rows
  for (const actor of crowd) assert.equal(crowdRows.find(row => row.user_id === actor.userId)?.n, 1)
  assert.equal(crowdRows.length, 20 + 3)
  ok('publicar y reservar compiten por el bloqueo del lote: veinte reservas concurrentes, un destinatario por persona, sin omisiones')

  // Reintentos y versiones concurrentes.
  const concurrentLot = await makeLot(est, 1), concurrent = await report(operator, concurrentLot)
  const same = command('publish', 0)
  const replays = await Promise.all(Array.from({ length: 5 }, () => incidents.command(operator, concurrent.id, same)))
  for (const replay of replays) assert.deepEqual(replay, replays[0])
  assert.equal((await db.query(`SELECT count(*)::int n FROM incident_versions v JOIN incidents i ON i.id=v.incident_id WHERE i.public_id=$1`, [concurrent.id])).rows[0].n, 1)
  const contested = await Promise.allSettled([incidents.command(operator, concurrent.id, command('update', 1)),
    incidents.command(operator, concurrent.id, command('resolve', 1))])
  assert.equal(contested.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(contested.find(result => result.status === 'rejected').reason.code, 'incident_version_conflict')
  ok('cinco reintentos simultáneos crean una versión; dos versiones distintas sobre la misma base dejan un solo ganador')

  // Lote cerrado: la publicación no lo reabre y conserva la entrega.
  const closed = await makeLot(est, 2), [pickedUp, withdrawnHolder] = await Promise.all([seeded(), seeded()])
  const pickupReservation = await reserve(pickedUp, closed); await reserve(withdrawnHolder, closed)
  await reservations.confirmPickup(operator, closed, pickupReservation.id,
    (await reservations.get(pickedUp, pickupReservation.id)).pickupCode, randomUUID(), () => undefined)
  await management.command(operator, closed, { action: 'withdraw', version: 1, reason: 'Retiro', idempotencyKey: randomUUID() })
  const beforeClosed = await lotState(closed)
  const closedIncident = await report(withdrawnHolder, closed)
  await incidents.command(operator, closedIncident.id, command('publish', 0))
  await incidents.command(operator, closedIncident.id, command('resolve', 1))
  assert.deepEqual(await lotState(closed), beforeClosed)
  assert.equal(beforeClosed.status, 'withdrawn'); assert.equal(beforeClosed.delivered_quantity, 1)
  assert.deepEqual(await recipients(closedIncident.id, 2),
    { [pickedUp.userId]: 'received', [withdrawnHolder.userId]: 'committed', [operator.userId]: 'operator', [alsoOperator.userId]: 'operator', [onlyOperator.userId]: 'operator' })
  ok('sobre un lote retirado se reporta, publica y resuelve sin reabrirlo y conservando la entrega')

  // Atomicidad: un fallo tras escribir no deja rastro y la clave se recupera.
  const rollbackLot = await makeLot(est, 1), rollbackIncident = await report(operator, rollbackLot)
  const repository = createIncidentRepository(pool)
  const failing = createIncidentUseCases({ ...repository,
    withCommand: (user, incidentId, intentKey, operate) => repository.withCommand(user, incidentId, intentKey, (state, writer) => operate(state, {
      ...writer, publish: async (...args) => { await writer.publish(...args); throw new Error('fallo posterior a publicar') },
    })),
  })
  const recovering = command('publish', 0)
  await assert.rejects(failing.command(operator, rollbackIncident.id, recovering), /fallo posterior/)
  const untouched = await incidents.list(operator, rollbackLot)
  assert.equal(untouched[0].status, 'reported'); assert.deepEqual(untouched[0].versions, [])
  assert.deepEqual(await recipients(rollbackIncident.id, 1), {})
  assert.equal((await incidents.command(operator, rollbackIncident.id, recovering)).version, 1)
  ok('un fallo posterior revierte estado, versión y destinatarios; la misma clave se recupera')

  console.log(`PASS K043: ${count} grupos con PostgreSQL real y contrato HTTP`)
} finally {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  await api.close(); await pool.end(); await db.end()
}
