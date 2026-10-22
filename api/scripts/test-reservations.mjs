// K022/K025: cancelación, retiro, concurrencia y plazos contra PostgreSQL real.
// Usa una base aislada y ya migrada; las carreras usan los casos de uso con el Pool real.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { assertContract } from '../test/support/openapi.ts'
import { createApi } from '../dist/composition.js'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createPickupCodes } from '../dist/infrastructure/crypto/pickup-codes.js'
import { createDiscoveryRepository } from '../dist/infrastructure/postgres/discovery-repository.js'
import { createReservationRepository } from '../dist/infrastructure/postgres/reservation-repository.js'
import { createDiscoveryUseCases } from '../dist/application/discovery/use-cases.js'
import { createReservationUseCases } from '../dist/application/reservations/use-cases.js'
import { createExpiryUseCases } from '../dist/application/expiries/use-cases.js'
import { createLotExpiryRepository } from '../dist/infrastructure/postgres/expiry-repository.js'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_(k022_test_|web_test_)/.test(new URL(connectionString).pathname.slice(1)),
  'Se requiere base de prueba aislada K022 o web')
const pickupKey = randomBytes(32)
const database = new pg.Client({ connectionString })
const api = createApi({ ...process.env, RESCATE_ALLOWED_ORIGINS: 'https://localhost:5173',
  CSRF_SIGNING_KEY: randomBytes(32).toString('base64'), PICKUP_CODE_KEY: pickupKey.toString('base64') })
const server = api.app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let checks = 0
const ok = label => console.log(`OK ${++checks}: ${label}`)
// Ningún registro del proceso puede contener un código emitido durante la prueba.
const issuedCodes = new Set()
const logged = []
for (const method of ['log', 'error', 'warn', 'info']) {
  const original = console[method]
  console[method] = (...args) => { logged.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')); original(...args) }
}

function client() {
  const cookies = new Map()
  let csrf = ''
  return async function call(method, path, body, retry = 0) {
    const response = await fetch(`${base}${path}`, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(method === 'GET' ? {} : { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf }) },
      body: body === undefined ? undefined : JSON.stringify(body) })
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';'); const at = pair.indexOf('=')
      cookies.set(pair.slice(0, at), pair.slice(at + 1))
    }
    const result = await response.json()
    if (result.csrfToken) csrf = result.csrfToken
    assertContract(method, path, response, result)
    if (response.status === 429 && retry < 3) {
      await new Promise(resolve => setTimeout(resolve, Number(response.headers.get('retry-after')) * 1000))
      return call(method, path, body, retry + 1)
    }
    if (typeof result.pickupCode === 'string') issuedCodes.add(result.pickupCode)
    return { status: response.status, body: result }
  }
}
async function person(label) {
  const call = client()
  await call('GET', '/auth/session')
  const email = `k022-${label}-${randomUUID()}@example.invalid`
  assert.equal((await call('POST', '/auth/register', { email, password: 'Clave-ficticia-K022-segura', privacyConsent: true })).status, 201)
  assert.equal((await call('POST', '/auth/login', { email, password: 'Clave-ficticia-K022-segura' })).status, 200)
  const { rows } = await database.query('SELECT id::text FROM users WHERE email = $1', [email])
  return { call, userId: rows[0].id }
}

const pool = createPool({ connectionString })
const codes = createPickupCodes(pickupKey)
const reservations = createReservationUseCases(createReservationRepository(pool), codes, () => new Date())
const discovery = createDiscoveryUseCases(createDiscoveryRepository(pool), codes, () => new Date())
const expiries = createExpiryUseCases(createLotExpiryRepository(pool), () => {})
const settle = promise => promise.then(value => ({ value }), error => ({ error }))
// Los casos de uso llamados sin HTTP no tienen origen que limitar (K034).
const anyOrigin = () => {}
// Cada contendiente debe esperar nuestro bloqueo, directamente o detrás de otro contendiente.
async function lockedRace(lotId, actions, whileBlocked = async () => {}) {
  const pending = []
  let committed = false
  await database.query('BEGIN')
  try {
    const { rows: [{ pid }] } = await database.query('SELECT pg_backend_pid() AS pid')
    await database.query('SELECT id FROM lots WHERE public_id = $1 FOR UPDATE', [lotId])
    const deadline = performance.now() + 1500
    for (const action of actions) {
      pending.push(settle(action()))
      let blocked = 0
      do {
        await database.query('SELECT pg_stat_clear_snapshot()')
        const waiting = await database.query(`WITH RECURSIVE waiting(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
          UNION
          SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
            WHERE a.datname = current_database()
        ) SELECT pid FROM waiting`, [pid])
        blocked = waiting.rowCount
        if (blocked === pending.length) break
        await new Promise(resolve => setTimeout(resolve, 10))
      } while (performance.now() < deadline)
      assert.equal(blocked, pending.length, `deben esperar ${pending.length} transacciones del lote ${lotId}`)
    }
    await whileBlocked(pending)
    await database.query('COMMIT')
    committed = true
    return await Promise.all(pending)
  } finally {
    if (!committed) await database.query('ROLLBACK')
    await Promise.all(pending)
  }
}
try {
  await database.connect()
  const establishment = async name => (await database.query(`INSERT INTO establishments
    (name, address, latitude, longitude, time_zone) VALUES ($1, 'Santiago', -33.45, -70.66, 'America/Santiago')
    RETURNING id`, [name])).rows[0].id
  const north = await establishment('K022 Norte')
  const south = await establishment('K022 Sur')
  // Por defecto la ventana ya comenzó y cierra en dos horas.
  const makeLot = async (quantity = 5, establishmentId = north, starts = '-1 hour', ends = '2 hours') =>
    (await database.query(`INSERT INTO lots (establishment_id, description, category, quantity, address, latitude,
       longitude, time_zone, pickup_starts_at, pickup_ends_at, status, published_at)
     VALUES ($1, 'Pack K022', 'Panadería', $2, 'Santiago Centro', -33.45, -70.66, 'America/Santiago',
       now() + $3::interval, now() + $4::interval, 'published', now() - interval '2 hours')
     RETURNING public_id::text AS id`, [establishmentId, quantity, starts, ends])).rows[0].id
  const counters = async lotId => (await database.query(`SELECT free_quantity AS f, reserved_quantity AS r,
      delivered_quantity AS e, expired_quantity AS x FROM lots WHERE public_id = $1`, [lotId])).rows[0]
  const status = async reservationId => (await database.query(
    'SELECT status, ended_at, pickup_code_ciphertext IS NOT NULL AS readable FROM commitments WHERE public_id = $1',
    [reservationId])).rows[0]

  const holder = await person('titular')
  const stranger = await person('ajeno')
  const operator = await person('operador')
  const colleague = await person('colega')
  const outsider = await person('otro-local')
  await database.query('INSERT INTO memberships (user_id, establishment_id) VALUES ($1, $3), ($2, $3), ($4, $5)',
    [operator.userId, colleague.userId, north, outsider.userId, south])

  // --- Código emitido al reservar, protegido y visible solo para su titular.
  const lot = await makeLot(5)
  const reserved = await holder.call('POST', `/public/lots/${lot}/reservations`, { quantity: 2, idempotencyKey: randomUUID() })
  assert.equal(reserved.status, 201)
  const reservationId = reserved.body.id
  const detail = await holder.call('GET', `/reservations/${reservationId}`)
  assert.equal(detail.status, 200)
  const code = detail.body.pickupCode
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  assert.deepEqual([detail.body.status, detail.body.lot.id, detail.body.quantity], ['confirmed', lot, 2])
  const [stored] = (await database.query(`SELECT pickup_code_ciphertext AS c, pickup_code_fingerprint AS h
    FROM commitments WHERE public_id = $1`, [reservationId])).rows
  assert.equal(stored.h.length, 32)
  assert.equal(stored.c.includes(Buffer.from(code)), false)
  assert.equal(stored.h.includes(Buffer.from(code)), false)
  assert.equal((await database.query(`SELECT count(*)::int AS n FROM commitments
    WHERE encode(pickup_code_ciphertext, 'escape') LIKE '%' || $1 || '%'`, [code])).rows[0].n, 0)
  assert.equal((await stranger.call('GET', `/reservations/${reservationId}`)).status, 404)
  assert.equal((await stranger.call('POST', `/reservations/${reservationId}/cancel`, {})).status, 404)
  const listed = await holder.call('GET', '/reservations')
  assert.deepEqual(listed.body.items.map(item => [item.id, 'pickupCode' in item]), [[reservationId, false]])
  assert.deepEqual((await stranger.call('GET', '/reservations')).body.items, [])
  ok('la reserva nace con código cifrado y huella; solo su titular lo consulta; el listado no lo incluye')

  // --- Revisar no acredita; confirmar revalida bajo bloqueo; la captura cancelada falla.
  assert.equal((await outsider.call('POST', `/lots/${lot}/pickup-reviews`, { code })).status, 403)
  assert.equal((await holder.call('POST', `/lots/${lot}/pickup-reviews`, { code })).status, 403)
  const otherLot = await makeLot(5, north)
  assert.equal((await operator.call('POST', `/lots/${otherLot}/pickup-reviews`, { code })).status, 404)
  assert.equal((await operator.call('POST', `/lots/${lot}/pickup-reviews`, { code: 'ZZZZZZZZ' })).status, 404)
  const review = await operator.call('POST', `/lots/${lot}/pickup-reviews`, { code: code.toLowerCase() })
  assert.deepEqual([review.body.reservation.id, review.body.reservation.status, review.body.canConfirm], [reservationId, 'confirmed', true])
  assert.equal((await status(reservationId)).status, 'confirmed')
  ok('revisar: operador del establecimiento ve la reserva sin consumirla; ajenos 403, otro lote o código 404')

  const cancelled = await holder.call('POST', `/reservations/${reservationId}/cancel`, {})
  assert.deepEqual([cancelled.status, cancelled.body.status, cancelled.body.pickupCode], [200, 'cancelled', null])
  assert.deepEqual(await counters(lot), { f: 5, r: 0, e: 0, x: 0 })
  assert.equal((await status(reservationId)).readable, false)
  assert.deepEqual((await holder.call('POST', `/reservations/${reservationId}/cancel`, {})).body, cancelled.body)
  assert.deepEqual(await counters(lot), { f: 5, r: 0, e: 0, x: 0 })
  const captured = await operator.call('POST', `/lots/${lot}/pickups`, { reservationId, code, idempotencyKey: randomUUID() })
  assert.equal(captured.status, 409)
  assert.equal((await operator.call('POST', `/lots/${lot}/pickup-reviews`, { code })).body.reservation.status, 'cancelled')
  assert.equal((await holder.call('GET', `/reservations/${reservationId}`)).body.pickupCode, null)
  ok('revisado y luego cancelado: confirmar falla con la captura; cancelar dos veces libera una sola vez')

  const again = await holder.call('POST', `/public/lots/${lot}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })
  assert.equal(again.status, 201)
  const newCode = (await holder.call('GET', `/reservations/${again.body.id}`)).body.pickupCode
  assert.notEqual(newCode, code)
  assert.equal((await operator.call('POST', `/lots/${lot}/pickups`,
    { reservationId: again.body.id, code, idempotencyKey: randomUUID() })).status, 404)
  ok('una reserva nueva del mismo lote obtiene otro código; el anterior no la habilita')

  // --- Dos operadores y reintentos: una sola entrega.
  const key = randomUUID()
  const body = { reservationId: again.body.id, code: newCode, idempotencyKey: key }
  const attempts = await lockedRace(lot, [
    () => operator.call('POST', `/lots/${lot}/pickups`, body),
    () => operator.call('POST', `/lots/${lot}/pickups`, body),
    () => colleague.call('POST', `/lots/${lot}/pickups`, { ...body, idempotencyKey: randomUUID() }),
  ])
  assert.ok(attempts.every(result => result.value), 'las tres solicitudes HTTP deben terminar')
  const [first, retry, rival] = attempts.map(result => result.value)
  assert.deepEqual([first.status, retry.status, rival.status], [201, 201, 409])
  assert.deepEqual(retry.body, first.body)
  assert.equal(first.body.reservationId, again.body.id)
  assert.equal((await database.query(`SELECT count(*)::int AS n FROM deliveries d JOIN commitments c ON c.id = d.commitment_id
    WHERE c.public_id = $1`, [again.body.id])).rows[0].n, 1)
  assert.deepEqual(await counters(lot), { f: 4, r: 0, e: 1, x: 0 })
  const replay = await operator.call('POST', `/lots/${lot}/pickups`, body)
  assert.deepEqual(replay, first)
  assert.equal((await operator.call('POST', `/lots/${lot}/pickups`, { ...body, idempotencyKey: randomUUID() })).status, 409)
  assert.equal((await holder.call('POST', `/reservations/${again.body.id}/cancel`, {})).status, 409)
  assert.equal((await operator.call('POST', `/lots/${lot}/pickup-reviews`, { code: newCode })).body.reservation.status, 'delivered')
  assert.equal((await status(again.body.id)).readable, false)
  await database.query("UPDATE lots SET pickup_ends_at = clock_timestamp() + interval '100 milliseconds' WHERE public_id = $1", [lot])
  await database.query('SELECT pg_sleep(GREATEST(0, extract(epoch FROM (pickup_ends_at - clock_timestamp())))) FROM lots WHERE public_id = $1', [lot])
  assert.deepEqual(await operator.call('POST', `/lots/${lot}/pickups`, body), first)
  ok('dos operadores y reintento con 3 bloqueos observados: [201, 201, 409], una entrega; replay idéntico incluso tras cierre')

  const lastPack = await makeLot(1)
  const lastKey = randomUUID()
  const lastAttempts = await lockedRace(lastPack, [
    () => discovery.reserve(holder, lastPack, 1, lastKey),
    () => discovery.reserve(holder, lastPack, 1, lastKey),
    () => discovery.reserve(stranger, lastPack, 1, randomUUID()),
  ])
  assert.ok(lastAttempts[0].value)
  assert.deepEqual(lastAttempts[1].value, lastAttempts[0].value)
  assert.equal(lastAttempts[2].error?.reason, 'unavailable')
  const restarted = createDiscoveryUseCases(createDiscoveryRepository(pool), codes, () => new Date())
  assert.deepEqual(await restarted.reserve(holder, lastPack, 1, lastKey), lastAttempts[0].value)
  assert.deepEqual(await counters(lastPack), { f: 0, r: 1, e: 0, x: 0 })
  assert.equal((await database.query(`SELECT count(*)::int AS n FROM commitments c JOIN lots l ON l.id = c.lot_id
    WHERE l.public_id = $1`, [lastPack])).rows[0].n, 1)
  issuedCodes.add((await reservations.get(holder, lastAttempts[0].value.id)).pickupCode)
  ok('última unidad con 3 bloqueos observados: reserva y replay idénticos, rival sin stock; otra instancia recupera la respuesta')

  // --- Cancelar y retirar compiten bajo bloqueo: una sola transición terminal por reserva.
  const raceLot = await makeLot(20)
  const racers = []
  for (let i = 0; i < 20; i++) {
    const { rows } = await database.query('INSERT INTO users(email) VALUES ($1) RETURNING id::text', [`k022-race-${randomUUID()}@example.invalid`])
    const created = await discovery.reserve({ userId: rows[0].id }, raceLot, 1, randomUUID())
    const { pickupCode } = await reservations.get({ userId: rows[0].id }, created.id)
    racers.push({ userId: rows[0].id, id: created.id, code: pickupCode })
  }
  const outcomes = []
  for (const [i, racer] of racers.entries()) {
    const actions = [
      () => reservations.cancel({ userId: racer.userId }, racer.id),
      () => reservations.confirmPickup(operator, raceLot, racer.id, racer.code, randomUUID(), anyOrigin),
    ]
    const results = await lockedRace(raceLot, i % 2 ? actions.reverse() : actions)
    outcomes.push(i % 2 ? results.reverse() : results)
  }
  let cancels = 0; let deliveries = 0
  for (const [i, [cancel, pickup]] of outcomes.entries()) {
    const final = (await status(racers[i].id)).status
    if (pickup.value) {
      deliveries++
      assert.equal(final, 'delivered')
      assert.equal(cancel.error?.reason, 'delivered', JSON.stringify(cancel))
    } else {
      cancels++
      assert.equal(final, 'cancelled')
      assert.equal(cancel.value?.status, 'cancelled')
      assert.equal(pickup.error?.reason, 'cancelled', JSON.stringify(pickup))
    }
    assert.equal(final, i % 2 ? 'delivered' : 'cancelled')
    console.log(`RACE K025 ${i + 1}/20: 2 bloqueos observados; reserva ${racers[i].id}: ${final}`)
  }
  assert.deepEqual([cancels, deliveries], [10, 10])
  assert.deepEqual(await counters(raceLot), { f: cancels, r: 0, e: deliveries, x: 0 })
  ok(`cancelar contra retirar en 20 reservas: una transición terminal cada una (${cancels} canceladas, ${deliveries} retiradas)`)

  // --- Plazos sin trabajador: antes del inicio y desde el cierre se rechaza.
  const early = await makeLot(3, north, '1 hour', '3 hours')
  const earlyReservation = await holder.call('POST', `/public/lots/${early}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })
  const earlyCode = (await holder.call('GET', `/reservations/${earlyReservation.body.id}`)).body.pickupCode
  const earlyReview = await operator.call('POST', `/lots/${early}/pickup-reviews`, { code: earlyCode })
  assert.deepEqual([earlyReview.body.reservation.status, earlyReview.body.canConfirm], ['confirmed', false])
  assert.equal((await operator.call('POST', `/lots/${early}/pickups`,
    { reservationId: earlyReservation.body.id, code: earlyCode, idempotencyKey: randomUUID() })).status, 409)
  await database.query(`UPDATE lots SET pickup_starts_at = now() - interval '3 hours', pickup_ends_at = now() - interval '1 second'
    WHERE public_id = $1`, [early])
  const expired = await holder.call('GET', `/reservations/${earlyReservation.body.id}`)
  assert.deepEqual([expired.body.status, expired.body.pickupCode], ['expired', null])
  assert.equal((await holder.call('POST', `/reservations/${earlyReservation.body.id}/cancel`, {})).status, 409)
  assert.equal((await operator.call('POST', `/lots/${early}/pickups`,
    { reservationId: earlyReservation.body.id, code: earlyCode, idempotencyKey: randomUUID() })).status, 409)
  assert.equal((await status(earlyReservation.body.id)).status, 'confirmed')
  assert.deepEqual(await counters(early), { f: 2, r: 1, e: 0, x: 0 })
  ok('sin trabajador: antes del inicio no se entrega; al cierre se rechaza cancelar y retirar y se informa vencida')

  // Registro del cierre como lo hace el trabajador (K028); su reclamo se prueba en test-expiries.mjs.
  assert.deepEqual(await expiries.expireLot(early), { lotClosed: true, expiredReservations: 1, closedEntries: 0 })
  const closedRow = await status(earlyReservation.body.id)
  assert.deepEqual([closedRow.status, closedRow.readable], ['expired', false])
  const { rows: [ends] } = await database.query(
    'SELECT status, closed_at, pickup_ends_at FROM lots WHERE public_id = $1', [early])
  assert.equal(closedRow.ended_at.getTime(), ends.pickup_ends_at.getTime())
  assert.deepEqual([ends.status, ends.closed_at.getTime()], ['expired', ends.pickup_ends_at.getTime()])
  assert.deepEqual(await counters(early), { f: 0, r: 0, e: 0, x: 3 })
  assert.deepEqual(await expiries.expireLot(early), { lotClosed: false, expiredReservations: 0, closedEntries: 0 })
  assert.deepEqual(await counters(early), { f: 0, r: 0, e: 0, x: 3 })
  // Registrado o no, la API responde igual: cancelar, retirar y reservar se rechazan con 409.
  assert.equal((await holder.call('GET', `/reservations/${earlyReservation.body.id}`)).body.status, 'expired')
  assert.equal((await holder.call('POST', `/reservations/${earlyReservation.body.id}/cancel`, {})).status, 409)
  assert.equal((await operator.call('POST', `/lots/${early}/pickups`,
    { reservationId: earlyReservation.body.id, code: earlyCode, idempotencyKey: randomUUID() })).status, 409)
  assert.equal((await stranger.call('POST', `/public/lots/${early}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })).status, 409)
  // Un lote cerrado sin reservas confirmadas también queda vencido, con lo libre en X.
  assert.deepEqual(await expiries.expireLot(lot), { lotClosed: true, expiredReservations: 0, closedEntries: 0 })
  ok('registrar el cierre vence el lote con closed_at = cierre, R y F → X con el cierre como término; repetirlo no libera; la API responde igual')

  // --- Cancelar espera el bloqueo y relee un cambio de ventana confirmado mientras esperaba.
  const waited = await makeLot(3)
  const waitedReservation = await discovery.reserve({ userId: holder.userId }, waited, 1, randomUUID())
  const [pending] = await lockedRace(waited, [() => reservations.cancel(holder, waitedReservation.id)], async () => {
    await database.query(`UPDATE lots SET pickup_starts_at = now() - interval '3 hours', pickup_ends_at = now() - interval '1 second'
      WHERE public_id = $1`, [waited])
  })
  assert.equal(pending.error?.reason, 'expired')
  assert.deepEqual(await counters(waited), { f: 2, r: 1, e: 0, x: 0 })
  ok('cancelar espera el bloqueo observado y relee la nueva ventana: no libera después del cierre')

  // El plazo ya está confirmado antes de BEGIN: solo avanza el reloj, no se cambia la ventana bajo bloqueo.
  for (const command of ['reserve', 'cancel', 'pickup', 'start']) {
    const timedLot = await makeLot(2)
    const created = command === 'reserve' ? null : await discovery.reserve(holder, timedLot, 1, randomUUID())
    const pickupCode = created && (await reservations.get(holder, created.id)).pickupCode
    if (pickupCode) issuedCodes.add(pickupCode)
    if (command === 'pickup') assert.equal((await reservations.reviewPickup(operator, timedLot, pickupCode, anyOrigin)).canConfirm, true)
    const boundary = command === 'start' ? 'pickup_starts_at' : 'pickup_ends_at'
    await database.query(`UPDATE lots SET ${boundary} = date_trunc('milliseconds', clock_timestamp() + interval '1200 milliseconds')
      WHERE public_id = $1`, [timedLot])
    const key = randomUUID()
    const action = command === 'reserve' ? () => discovery.reserve(holder, timedLot, 1, key)
      : command === 'cancel' ? () => reservations.cancel(holder, created.id)
      : () => reservations.confirmPickup(operator, timedLot, created.id, pickupCode, key, anyOrigin)
    const [result] = await lockedRace(timedLot, [action], async () => {
      assert.equal((await database.query(`SELECT clock_timestamp() < ${boundary} AS before
        FROM lots WHERE public_id = $1`, [timedLot])).rows[0].before, true, `${command} debe bloquearse antes del límite`)
      await database.query(`SELECT pg_sleep(GREATEST(0, extract(epoch FROM (${boundary} - clock_timestamp()))))
        FROM lots WHERE public_id = $1`, [timedLot])
      assert.equal((await database.query(`SELECT clock_timestamp() >= ${boundary} AS crossed
        FROM lots WHERE public_id = $1`, [timedLot])).rows[0].crossed, true)
    })
    if (command === 'start') {
      assert.ok(result.value, 'el retiro debe aceptar el inicio alcanzado durante la espera')
      assert.deepEqual(await counters(timedLot), { f: 1, r: 0, e: 1, x: 0 })
    } else {
      assert.equal(result.error?.reason, command === 'reserve' ? 'unavailable' : 'expired')
      assert.deepEqual(await counters(timedLot), { f: created ? 1 : 2, r: created ? 1 : 0, e: 0, x: 0 })
      assert.equal((await database.query(`SELECT count(*)::int AS n FROM commitments c JOIN lots l ON l.id = c.lot_id
        WHERE l.public_id = $1`, [timedLot])).rows[0].n, created ? 1 : 0)
      assert.equal((await database.query('SELECT count(*)::int AS n FROM deliveries WHERE idempotency_key = $1', [key])).rows[0].n, 0)
      if (created) assert.deepEqual([(await status(created.id)).status, (await status(created.id)).readable], ['confirmed', true])
    }
    ok(`${command}: bloqueo observado antes del límite, reloj PostgreSQL lo cruza; ${result.value ? 'retiro aceptado desde el inicio' : result.error.reason}, inventario conciliado`)
  }

  const timeoutLot = await makeLot(1)
  const timeoutReservation = await discovery.reserve(holder, timeoutLot, 1, randomUUID())
  const timeoutCode = (await reservations.get(holder, timeoutReservation.id)).pickupCode
  issuedCodes.add(timeoutCode)
  const timeoutKey = randomUUID()
  const pickupAfterTimeout = () => reservations.confirmPickup(operator, timeoutLot, timeoutReservation.id, timeoutCode, timeoutKey, anyOrigin)
  await lockedRace(timeoutLot, [pickupAfterTimeout], async ([attempt]) => {
    assert.equal((await attempt).error?.code, '55P03')
  })
  assert.deepEqual(await counters(timeoutLot), { f: 0, r: 1, e: 0, x: 0 })
  assert.equal((await database.query('SELECT count(*)::int AS n FROM deliveries WHERE idempotency_key = $1', [timeoutKey])).rows[0].n, 0)
  const afterTimeout = await pickupAfterTimeout()
  assert.deepEqual(await pickupAfterTimeout(), afterTimeout)
  assert.deepEqual(await counters(timeoutLot), { f: 0, r: 0, e: 1, x: 0 })
  ok('retiro bloqueado supera 2 s: 55P03 sin entrega ni clave consumida; reintento y replay entregan una sola vez')

  // --- Un fallo después de escribir revierte entrega, estado, contador y clave.
  const rollbackLot = await makeLot(2)
  const rollbackReservation = await discovery.reserve({ userId: holder.userId }, rollbackLot, 1, randomUUID())
  const rollbackCode = (await reservations.get({ userId: holder.userId }, rollbackReservation.id)).pickupCode
  const repository = createReservationRepository(pool)
  const failing = createReservationUseCases({ ...repository,
    withPickupAttempts: (operatorUserId, operate) => repository.withPickupAttempts(operatorUserId, (attempts, steps) =>
      operate(attempts, { ...steps, confirm: (...args) => {
        const confirm = args.pop()
        return steps.confirm(...args, (state, writer) => confirm(state, {
          deliver: async at => { await writer.deliver(at); throw new Error('fallo posterior a la entrega') } }))
      } })),
  }, codes, () => new Date())
  const rollbackKey = randomUUID()
  await assert.rejects(failing.confirmPickup({ userId: operator.userId }, rollbackLot, rollbackReservation.id, rollbackCode, rollbackKey, anyOrigin),
    /fallo posterior/)
  assert.deepEqual([(await status(rollbackReservation.id)).status, (await status(rollbackReservation.id)).readable], ['confirmed', true])
  assert.deepEqual(await counters(rollbackLot), { f: 1, r: 1, e: 0, x: 0 })
  assert.equal((await database.query('SELECT count(*)::int AS n FROM deliveries WHERE idempotency_key = $1', [rollbackKey])).rows[0].n, 0)
  const recovered = await reservations.confirmPickup({ userId: operator.userId }, rollbackLot, rollbackReservation.id, rollbackCode, rollbackKey, anyOrigin)
  assert.equal(recovered.quantity, 1)
  ok('fallo tras escribir revierte entrega, estado, código y contadores; la misma clave se puede reintentar')

  // --- Reserva confirmada antes de K022: recibe su código una sola vez.
  const legacyLot = await makeLot(2)
  const { rows: [legacy] } = await database.query(`WITH c AS (INSERT INTO commitments (user_id, lot_id, quantity, status)
      SELECT $1, id, 1, 'confirmed' FROM lots WHERE public_id = $2 RETURNING public_id, lot_id)
    UPDATE lots SET reserved_quantity = reserved_quantity + 1 FROM c WHERE lots.id = c.lot_id
    RETURNING c.public_id::text AS id`, [holder.userId, legacyLot])
  const issued = await Promise.all([0, 1, 2].map(() => holder.call('GET', `/reservations/${legacy.id}`)))
  assert.equal(new Set(issued.map(result => result.body.pickupCode)).size, 1)
  assert.match(issued[0].body.pickupCode, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  ok('una reserva confirmada sin código recibe uno al consultarla, también con consultas simultáneas')

  // --- Inventario conciliado con sus registros y ningún código en los registros del proceso.
  const unreconciled = await database.query(`SELECT l.public_id FROM lots l
    WHERE l.quantity <> l.free_quantity + l.offered_quantity + l.reserved_quantity + l.delivered_quantity + l.expired_quantity
       OR LEAST(l.free_quantity, l.offered_quantity, l.reserved_quantity, l.delivered_quantity, l.expired_quantity) < 0
       OR l.reserved_quantity <> COALESCE((SELECT sum(c.quantity) FROM commitments c WHERE c.lot_id = l.id AND c.status = 'confirmed'), 0)
       OR l.delivered_quantity <> COALESCE((SELECT sum(d.quantity) FROM deliveries d JOIN commitments c ON c.id = d.commitment_id WHERE c.lot_id = l.id), 0)
       -- Abierto: X son las reservas vencidas. Vencido (K028): no queda F, O ni R, y X = Q - E.
       OR l.status <> 'expired' AND l.expired_quantity <> COALESCE((SELECT sum(c.quantity) FROM commitments c WHERE c.lot_id = l.id AND c.status = 'expired'), 0)
       OR l.status = 'expired' AND l.free_quantity + l.offered_quantity + l.reserved_quantity <> 0
       OR EXISTS (SELECT 1 FROM commitments c WHERE c.lot_id = l.id
         AND (SELECT count(*) FROM deliveries d WHERE d.commitment_id = c.id) <> CASE WHEN c.status = 'delivered' THEN 1 ELSE 0 END)
       OR EXISTS (SELECT 1 FROM deliveries d JOIN commitments c ON c.id = d.commitment_id
         WHERE c.lot_id = l.id AND (d.quantity <> c.quantity OR d.delivered_at <> c.ended_at
           OR d.delivered_at < l.pickup_starts_at OR d.delivered_at >= l.pickup_ends_at))`)
  assert.deepEqual(unreconciled.rows, [])
  for (const racer of racers) issuedCodes.add(racer.code)
  for (const value of [code, newCode, earlyCode, rollbackCode]) issuedCodes.add(value)
  assert.ok(logged.every(line => [...issuedCodes].every(value => !line.includes(value))))
  ok('conciliación: Q = F + O + R + E + X sin negativos; R/E/X y entregas únicas dentro de ventana coinciden con registros; códigos ausentes de logs')
  console.log(`PASS K022/K025: ${checks} grupos de integración con PostgreSQL real`)
} finally {
  await database.query('ROLLBACK').catch(() => {})
  await database.end().catch(() => {})
  await pool.end()
  await new Promise(resolve => server.close(resolve))
  await api.close()
}
