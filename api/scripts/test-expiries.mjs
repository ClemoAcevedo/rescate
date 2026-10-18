// K028: vencimientos de lotes, reservas y ofertas contra PostgreSQL real con procesos
// reales del worker. Usa una base aislada y ya migrada; el worker se lanza y detiene aquí.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import pg from 'pg'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createPickupCodes } from '../dist/infrastructure/crypto/pickup-codes.js'
import { createDiscoveryRepository } from '../dist/infrastructure/postgres/discovery-repository.js'
import { createReservationRepository } from '../dist/infrastructure/postgres/reservation-repository.js'
import { createWaitlistRepository } from '../dist/infrastructure/postgres/waitlist-repository.js'
import { createLotExpiryRepository } from '../dist/infrastructure/postgres/expiry-repository.js'
import { createDiscoveryUseCases } from '../dist/application/discovery/use-cases.js'
import { createReservationUseCases } from '../dist/application/reservations/use-cases.js'
import { createWaitlistUseCases } from '../dist/application/waitlist/use-cases.js'
import { createExpiryUseCases } from '../dist/application/expiries/use-cases.js'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_k028_test_/.test(new URL(connectionString).pathname.slice(1)),
  'Se requiere base de prueba aislada K028')
let checks = 0
const ok = label => console.log(`OK ${++checks}: ${label}`)
const settle = promise => promise.then(value => ({ value }), error => ({ error }))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(label, condition, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await condition()) return; await sleep(50) }
  assert.fail(`Tiempo agotado: ${label}`)
}

const workers = []
/** Proceso real del worker, solo con la base: registra vencimientos y no procesa fotos. */
function startWorker() {
  const { PHOTO_STORAGE: _storage, WORKER_EXPIRIES: _expiries, ...env } = process.env
  const child = spawn(process.execPath, ['dist/worker.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const worker = { child, output: '' }
  child.stdout.on('data', chunk => { worker.output += chunk })
  child.stderr.on('data', chunk => { worker.output += chunk })
  workers.push(worker)
  return worker
}
async function stopWorker(worker, signal = 'SIGTERM') {
  const exited = once(worker.child, 'exit')
  worker.child.kill(signal)
  const [code, received] = await exited
  return { code, signal: received }
}
const events = worker => worker.output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))

const database = new pg.Client({ connectionString })
const pool = createPool({ connectionString })
const codes = createPickupCodes(randomBytes(32))
const reservations = createReservationUseCases(createReservationRepository(pool), codes, () => new Date())
const discovery = createDiscoveryUseCases(createDiscoveryRepository(pool), codes, () => new Date())
const waitlist = createWaitlistUseCases(createWaitlistRepository(pool), codes, () => new Date())
const expiryRepository = createLotExpiryRepository(pool)
try {
  await database.connect()
  const { rows: [{ id: establishment }] } = await database.query(`INSERT INTO establishments
    (name, address, latitude, longitude, time_zone) VALUES ('K028 Local', 'Santiago', -33.45, -70.66, 'America/Santiago')
    RETURNING id`)
  const makeLot = async (quantity = 10, status = 'published') => (await database.query(`INSERT INTO lots
      (establishment_id, description, category, quantity, address, latitude, longitude, time_zone,
       pickup_starts_at, pickup_ends_at, status, published_at)
     VALUES ($1, 'Pack K028', 'Panadería', $2, 'Santiago Centro', -33.45, -70.66, 'America/Santiago',
       now() - interval '1 hour', now() + interval '2 hours', $3::lot_status,
       CASE WHEN $3 = 'published' THEN now() - interval '2 hours' END)
     RETURNING public_id::text AS id`, [establishment, quantity, status])).rows[0].id
  const people = []
  for (let i = 0; i < 12; i++) {
    people.push((await database.query('INSERT INTO users (email) VALUES ($1) RETURNING id::text',
      [`k028-${i}-${randomUUID()}@example.invalid`])).rows[0].id)
  }
  const actor = i => ({ userId: people[i] })
  /** Reserva `count` personas distintas, `quantity` packs cada una, con el lote vigente. */
  const reserve = async (lotId, count, quantity = 1) => {
    const ids = []
    for (let i = 0; i < count; i++) ids.push((await discovery.reserve(actor(i), lotId, quantity, randomUUID())).id)
    return ids
  }
  /** El lote cierra hace un minuto: el registro debe usar este instante, no el de proceso. */
  const close = async lotId => (await database.query(`UPDATE lots SET pickup_ends_at = date_trunc('second', now()) - interval '1 minute'
    WHERE public_id = $1 RETURNING pickup_ends_at`, [lotId])).rows[0].pickup_ends_at
  const lotRow = async lotId => (await database.query(`SELECT status::text, closed_at, free_quantity AS f,
      offered_quantity AS o, reserved_quantity AS r, delivered_quantity AS e, expired_quantity AS x,
      expiry_attempts AS attempts, expiry_claimed_until AS claimed
    FROM lots WHERE public_id = $1`, [lotId])).rows[0]
  const counters = async lotId => { const { f, o, r, e, x } = await lotRow(lotId); return { f, o, r, e, x } }
  const statuses = async lotId => (await database.query(`SELECT c.status, c.ended_at, c.pickup_code_ciphertext IS NOT NULL AS readable
    FROM commitments c JOIN lots l ON l.id = c.lot_id WHERE l.public_id = $1 ORDER BY c.id`, [lotId])).rows
  const entry = async entryId => (await database.query(`SELECT status, offered_quantity, ended_at, offer_expires_at
    FROM waitlist_entries WHERE public_id = $1`, [entryId])).rows[0]
  const pending = async () => (await database.query(`SELECT l.public_id::text AS id FROM lots l
    WHERE l.status = 'published' AND l.pickup_ends_at <= clock_timestamp()
       OR EXISTS (SELECT 1 FROM waitlist_entries w WHERE w.lot_id = l.id AND w.status = 'offered'
         AND w.offer_expires_at <= clock_timestamp())`)).rows.map(row => row.id)

  // --- Sin trabajador: la API decide con el cierre y nada se registra.
  const stopped = await makeLot(5)
  const [stoppedReservation] = await reserve(stopped, 1, 2)
  const stoppedEnds = await close(stopped)
  assert.equal((await settle(reservations.cancel(actor(0), stoppedReservation))).error?.reason, 'expired')
  assert.equal((await settle(discovery.reserve(actor(1), stopped, 1, randomUUID()))).error?.reason, 'unavailable')
  assert.equal((await settle(waitlist.join(actor(1), stopped, 9, randomUUID()))).error?.reason, 'unavailable')
  const shown = await reservations.get(actor(0), stoppedReservation)
  assert.deepEqual([shown.status, shown.pickupCode, shown.endedAt.getTime()], ['expired', null, stoppedEnds.getTime()])
  assert.deepEqual((await statuses(stopped)).map(row => row.status), ['confirmed'])
  assert.deepEqual(await lotRow(stopped), { status: 'published', closed_at: null, f: 3, o: 0, r: 2, e: 0, x: 0,
    attempts: 0, claimed: null })
  ok('trabajador detenido: cancelar, reservar y esperar se rechazan desde el cierre, la reserva se informa vencida y nada se registra')

  // --- Un borrador cerrado nunca se reclama.
  const draft = await makeLot(3, 'draft')
  await close(draft)

  // --- Worker real: vence lote y reservas con el instante del cierre, una vez.
  let worker = startWorker()
  await until('cierre registrado por el worker', async () => (await lotRow(stopped)).status === 'expired')
  const recorded = await lotRow(stopped)
  assert.deepEqual(recorded, { status: 'expired', closed_at: stoppedEnds, f: 0, o: 0, r: 0, e: 0, x: 5,
    attempts: 0, claimed: null })
  const [expired] = await statuses(stopped)
  assert.deepEqual([expired.status, expired.ended_at.getTime(), expired.readable], ['expired', stoppedEnds.getTime(), false])
  assert.deepEqual(await lotRow(draft).then(row => [row.status, row.attempts]), ['draft', 0])
  // Registrado el cierre, la API responde lo mismo que antes.
  assert.equal((await settle(reservations.cancel(actor(0), stoppedReservation))).error?.reason, 'expired')
  assert.equal((await settle(discovery.reserve(actor(1), stopped, 1, randomUUID()))).error?.reason, 'unavailable')
  assert.equal((await settle(waitlist.join(actor(1), stopped, 9, randomUUID()))).error?.reason, 'unavailable')
  assert.equal((await stopWorker(worker)).code, 0, 'SIGTERM termina el worker de forma ordenada')
  assert.match(worker.output, /Worker iniciado: vencimientos\n/)
  assert.deepEqual(events(worker), [{ event: 'lot_expiry', lotId: stopped, attempts: 1,
    lotClosed: true, expiredReservations: 1, closedEntries: 0 }])
  assert.doesNotMatch(worker.output, /postgresql:|worker_error/)
  ok('worker real: lote expired con closed_at = cierre, R y F → X, reserva vencida al cierre sin código; la API responde igual; el borrador no se reclama')

  // --- Oferta vencida en un lote abierto: se registra, libera O → F y se ofrece a quien sigue.
  const queued = await makeLot(2)
  const [queuedReservation] = await reserve(queued, 1, 2)
  const first = await waitlist.join(actor(1), queued, 2, randomUUID())
  const second = await waitlist.join(actor(2), queued, 1, randomUUID())
  await reservations.cancel(actor(0), queuedReservation)
  assert.deepEqual([(await entry(first.id)).status, (await entry(second.id)).status], ['offered', 'waiting'])
  const { rows: [lapse] } = await database.query(`UPDATE waitlist_entries SET offered_at = offered_at - interval '1 hour',
    offer_expires_at = offer_expires_at - interval '1 hour' WHERE public_id = $1 RETURNING offer_expires_at`, [first.id])
  assert.deepEqual(await counters(queued), { f: 0, o: 2, r: 0, e: 0, x: 0 })
  assert.equal((await waitlist.get(actor(1), first.id)).status, 'expired', 'la API la informa vencida sin trabajador')
  worker = startWorker()
  await until('oferta vencida registrada', async () => (await entry(first.id)).status === 'expired')
  await until('oferta siguiente', async () => (await entry(second.id)).status === 'offered')
  assert.deepEqual((await entry(first.id)).ended_at, lapse.offer_expires_at)
  assert.deepEqual(await counters(queued), { f: 1, o: 1, r: 0, e: 0, x: 0 })
  assert.deepEqual(await lotRow(queued).then(row => [row.status, row.attempts]), ['published', 0])
  assert.equal((await stopWorker(worker)).code, 0)
  assert.deepEqual(events(worker), [{ event: 'lot_expiry', lotId: queued, attempts: 1,
    lotClosed: false, expiredReservations: 0, closedEntries: 1 }])
  ok('oferta vencida en lote abierto: termina a su hora, O → F y se ofrece a la siguiente en la cola; el lote sigue publicado')

  // --- Repetir un cierre, también en paralelo, no libera dos veces.
  const repeated = await makeLot(12)
  await reserve(repeated, 10)
  await close(repeated)
  const quick = createExpiryUseCases(expiryRepository, () => {})
  const runs = await Promise.all([...Array(4)].map(() => settle(quick.expireLot(repeated))))
  assert.ok(runs.every(run => 'value' in run), JSON.stringify(runs))
  assert.equal(runs.filter(run => run.value.lotClosed).length, 1)
  assert.equal(runs.reduce((total, run) => total + run.value.expiredReservations, 0), 10)
  assert.deepEqual(await quick.expireLot(repeated), { lotClosed: false, expiredReservations: 0, closedEntries: 0 })
  assert.deepEqual(await quick.expireLot(stopped), { lotClosed: false, expiredReservations: 0, closedEntries: 0 })
  assert.deepEqual(await counters(repeated), { f: 0, o: 0, r: 0, e: 0, x: 12 })
  assert.equal(await quick.expireNext(), false, 'ya no queda vencimiento pendiente')
  ok('cuatro cierres simultáneos y repeticiones vencen 10 reservas una sola vez: X = Q, R = F = 0')

  // --- Un worker muere con el lote reclamado: nadie lo toma durante la concesión y un
  // worker reiniciado lo recupera al vencer.
  const crashed = await makeLot(4)
  await reserve(crashed, 3)
  const crashedEnds = await close(crashed)
  assert.deepEqual(await expiryRepository.claimNext(1500, 5), { lotId: crashed, attempts: 1 })
  assert.equal(await quick.expireNext(), false, 'la concesión vigente impide un segundo reclamo')
  assert.equal(await expiryRepository.claimNext(1500, 5), null)
  worker = startWorker()
  await until('cierre recuperado tras la concesión', async () => (await lotRow(crashed)).status === 'expired')
  assert.deepEqual(await counters(crashed), { f: 0, o: 0, r: 0, e: 0, x: 4 })
  assert.ok((await statuses(crashed)).every(row => row.status === 'expired' && row.ended_at.getTime() === crashedEnds.getTime()))
  // Un trabajador viejo que libera tarde no pisa el registro.
  await expiryRepository.release(crashed, 1, 60_000)
  assert.deepEqual(await lotRow(crashed).then(row => [row.attempts, row.claimed]), [0, null])
  assert.equal((await stopWorker(worker)).code, 0)
  assert.equal(events(worker)[0].attempts, 2)
  ok('concesión: el reclamo de un worker caído bloquea a otros hasta vencer; el reiniciado recupera con el intento 2')

  // --- kill -9 a mitad del registro: el worker ya reclamó y bloqueó el lote, y espera
  // una reserva retenida aquí. Su transacción se revierte y otro worker la completa.
  const killed = await makeLot(3)
  await reserve(killed, 2)
  await close(killed)
  await database.query('BEGIN')
  await database.query(`SELECT 1 FROM commitments c JOIN lots l ON l.id = c.lot_id
    WHERE l.public_id = $1 FOR UPDATE OF c`, [killed])
  worker = startWorker()
  await until('worker esperando la reserva retenida', async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'
      AND query LIKE '%UPDATE public.commitments SET status = ''expired''%'`)).rowCount > 0, 1500)
  assert.equal((await stopWorker(worker, 'SIGKILL')).signal, 'SIGKILL')
  await database.query('COMMIT')
  const orphaned = await lotRow(killed)
  assert.deepEqual([orphaned.status, orphaned.r, orphaned.x, orphaned.attempts], ['published', 2, 0, 1])
  assert.ok((await statuses(killed)).every(row => row.status === 'confirmed'))
  assert.ok(orphaned.claimed > new Date(), 'la concesión del worker muerto sigue vigente')
  // Se adelanta el vencimiento de la concesión para no esperar el minuto completo.
  await database.query('UPDATE lots SET expiry_claimed_until = now() WHERE public_id = $1', [killed])
  worker = startWorker()
  await until('cierre completado tras kill -9', async () => (await lotRow(killed)).status === 'expired')
  assert.deepEqual(await counters(killed), { f: 0, o: 0, r: 0, e: 0, x: 3 })
  assert.equal((await stopWorker(worker)).code, 0)
  assert.equal(events(worker)[0].attempts, 2)
  ok('kill -9 a mitad del registro: nada queda a medias y el worker reiniciado lo completa al vencer la concesión')

  // --- Dos workers a la vez: cada lote se reclama y registra una vez.
  const many = []
  for (let i = 0; i < 6; i++) { const id = await makeLot(4); await reserve(id, 2, 2); many.push(id) }
  for (const id of many) await close(id)
  const pair = [startWorker(), startWorker()]
  await until('seis cierres con dos workers', async () => (await pending()).length === 0)
  for (const one of pair) assert.equal((await stopWorker(one)).code, 0)
  for (const id of many) assert.deepEqual(await counters(id), { f: 0, o: 0, r: 0, e: 0, x: 4 })
  const handled = pair.flatMap(events)
  assert.deepEqual(handled.map(event => event.lotId).sort(), [...many].sort())
  assert.ok(handled.every(event => event.attempts === 1 && event.lotClosed && event.expiredReservations === 2))
  ok(`dos workers en paralelo: seis cierres, uno por lote y un intento cada uno (${pair.map(one => events(one).length).join(' y ')})`)

  // --- Reintentos acotados: la reserva retenida agota los intentos y el lote queda para revisión.
  const busy = await makeLot(3)
  const [busyReservation] = await reserve(busy, 1)
  await close(busy)
  const logged = []
  const limited = createExpiryUseCases(expiryRepository, event => logged.push(event),
    { leaseMs: 10_000, maxAttempts: 2, retryDelayMs: 300 })
  // Un lote bloqueado por un comando se salta sin gastar intentos.
  await database.query('BEGIN')
  await database.query('SELECT 1 FROM lots WHERE public_id = $1 FOR UPDATE', [busy])
  assert.equal(await limited.expireNext(), false)
  await database.query('COMMIT')
  assert.equal((await lotRow(busy)).attempts, 0)
  await database.query('BEGIN')
  await database.query(`SELECT 1 FROM commitments c JOIN lots l ON l.id = c.lot_id
    WHERE l.public_id = $1 FOR UPDATE OF c`, [busy])
  assert.equal(await limited.expireNext(), true)
  const postponed = await lotRow(busy)
  assert.deepEqual([postponed.status, postponed.attempts], ['published', 1])
  assert.ok(postponed.claimed > new Date(), 'el fallo pospone el siguiente reclamo')
  assert.equal(await limited.expireNext(), false, 'durante la espera no se reintenta')
  await sleep(400)
  assert.equal(await limited.expireNext(), true)
  assert.deepEqual(logged.map(event => [event.event, event.attempts, event.code]),
    [['lot_expiry_retry', 1, '55P03'], ['lot_expiry_exhausted', 2, '55P03']])
  await database.query('COMMIT')
  const exhausted = await lotRow(busy)
  assert.deepEqual([exhausted.status, exhausted.r, exhausted.attempts, exhausted.claimed], ['published', 1, 2, null])
  assert.equal(await limited.expireNext(), false, 'agotado no se vuelve a reclamar')
  assert.equal((await settle(reservations.cancel(actor(0), busyReservation))).error?.reason, 'expired')
  // Tras revisar la causa, reiniciar los intentos lo devuelve al trabajador.
  await database.query('UPDATE lots SET expiry_attempts = 0 WHERE public_id = $1', [busy])
  assert.equal(await limited.expireNext(), true)
  assert.deepEqual(await lotRow(busy).then(row => [row.status, row.r, row.x, row.attempts]), ['expired', 0, 3, 0])
  ok('reintentos acotados: un lote bloqueado se salta sin gastar intentos; esperar 2 s una reserva pospone, el segundo fallo agota y la API sigue rechazando; reiniciar intentos lo completa')

  // --- Conciliación: Q = F + O + R + E + X; R y O coinciden con sus registros y los
  // lotes vencidos no conservan F, O ni R.
  const unreconciled = await database.query(`SELECT l.public_id FROM lots l
    WHERE l.quantity <> l.free_quantity + l.offered_quantity + l.reserved_quantity + l.delivered_quantity + l.expired_quantity
       OR l.reserved_quantity <> COALESCE((SELECT sum(c.quantity) FROM commitments c WHERE c.lot_id = l.id AND c.status = 'confirmed'), 0)
       OR l.offered_quantity <> COALESCE((SELECT sum(w.offered_quantity) FROM waitlist_entries w WHERE w.lot_id = l.id AND w.status = 'offered'), 0)
       OR l.status = 'expired' AND (l.free_quantity + l.offered_quantity + l.reserved_quantity <> 0
         OR l.closed_at <> l.pickup_ends_at)`)
  assert.deepEqual(unreconciled.rows, [])
  assert.deepEqual(await pending(), [])
  ok('conciliación: Q = F + O + R + E + X, R y O con sus registros, y ningún vencimiento pendiente')
  console.log(`PASS K028: ${checks} grupos de integración con PostgreSQL real y worker real`)
} finally {
  for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) await stopWorker(worker, 'SIGKILL')
  await database.query('ROLLBACK').catch(() => {})
  await database.end().catch(() => {})
  await pool.end()
}
