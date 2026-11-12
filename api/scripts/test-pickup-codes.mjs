// K049 regresión de códigos de retiro contra cada vía que cierra una reserva (anexos E1 I p. 27).
// Usa los casos de uso reales con PostgreSQL. Las carreras fijan el orden con un bloqueo propio del lote.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createPickupCodes } from '../dist/infrastructure/crypto/pickup-codes.js'
import { createDiscoveryRepository } from '../dist/infrastructure/postgres/discovery-repository.js'
import { createDiscoveryUseCases } from '../dist/application/discovery/use-cases.js'
import { createReservationRepository } from '../dist/infrastructure/postgres/reservation-repository.js'
import { createReservationUseCases } from '../dist/application/reservations/use-cases.js'
import { createLotManagementRepository } from '../dist/infrastructure/postgres/lot-management-repository.js'
import { createLotManagement } from '../dist/application/lots/management.js'
import { createIncidentRepository } from '../dist/infrastructure/postgres/incident-repository.js'
import { createIncidentUseCases } from '../dist/application/incidents/use-cases.js'
import { createLotExpiryRepository } from '../dist/infrastructure/postgres/expiry-repository.js'
import { createExpiryUseCases } from '../dist/application/expiries/use-cases.js'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_k049_test_/.test(new URL(connectionString).pathname.slice(1)), 'Solo base dedicada K049')
const pool = createPool({ connectionString }), gate = new pg.Client({ connectionString })
const codes = createPickupCodes(randomBytes(32)), now = () => new Date()
const reservations = createReservationUseCases(createReservationRepository(pool), codes, now)
const discovery = createDiscoveryUseCases(createDiscoveryRepository(pool), codes, now)
const management = createLotManagement(createLotManagementRepository(pool))
const incidents = createIncidentUseCases(createIncidentRepository(pool))
const expiries = createExpiryUseCases(createLotExpiryRepository(pool), () => {})
const query = async (sql, values) => (await pool.query(sql, values)).rows
const settle = promise => promise.then(value => ({ value }), error => ({ error }))
// Los casos de uso llamados sin HTTP no tienen origen que limitar (K034).
const admit = () => {}
let checks = 0
const ok = label => console.log(`OK K049 ${++checks}: ${label}`)
// Reservas cuyo código quedó invalidado. Al final ninguna puede tener entrega.
const invalidated = []
const label = { cancel: 'cancelación', withdraw: 'retiro de publicación', incident: 'cierre por incidencia',
  'expiry-pending': 'plazo vencido sin registrar', expiry: 'vencimiento registrado' }

let establishment
const person = async () => ({ userId: (await query('INSERT INTO users(email) VALUES ($1) RETURNING id::text',
  [`k049-${randomUUID()}@example.invalid`]))[0].id })
async function operator() {
  const actor = await person()
  await query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)', [actor.userId, establishment])
  return actor
}
const makeLot = async quantity => (await query(`INSERT INTO lots(establishment_id,description,category,quantity,address,
  latitude,longitude,time_zone,pickup_starts_at,pickup_ends_at,status,published_at)
  VALUES ($1,'Lote K049','Prueba',$2,'Santiago',-33.45,-70.66,'America/Santiago',now()-interval '1 hour',
    now()+interval '2 hours','published',now()) RETURNING public_id::text AS id`, [establishment, quantity]))[0].id
const counters = async lot => (await query(`SELECT status, free_quantity f, offered_quantity o, reserved_quantity r,
  delivered_quantity e, expired_quantity x FROM lots WHERE public_id=$1`, [lot]))[0]
const deliveries = async id => (await query(`SELECT count(*)::int n FROM deliveries d
  JOIN commitments c ON c.id=d.commitment_id WHERE c.public_id=$1`, [id]))[0].n
async function reserve(holder, lot) {
  const { id } = await discovery.reserve(holder, lot, 1, randomUUID())
  return { id, code: (await reservations.get(holder, id)).pickupCode }
}
const deliver = (actor, lot, reservation, key = randomUUID()) =>
  reservations.confirmPickup(actor, lot, reservation.id, reservation.code, key, admit)

// Cada vía se prepara antes de la carrera y devuelve solo el comando que compite por el lote.
const closers = {
  cancel: async ({ holder, reservation }) => () => reservations.cancel(holder, reservation.id),
  withdraw: async ({ lot, desk }) => {
    const [{ version }] = await query('SELECT version FROM lots WHERE public_id=$1', [lot])
    const input = { action: 'withdraw', version, reason: 'Retiro K049', idempotencyKey: randomUUID() }
    return () => management.command(desk, lot, input)
  },
  incident: async ({ lot, holder, desk }) => {
    const incident = await incidents.report(holder, lot, { reason: 'Problema K049', idempotencyKey: randomUUID() })
    const input = { action: 'publish', version: 0, reason: 'Cierre K049', instructions: 'No consumir',
      idempotencyKey: randomUUID(), closeLot: true }
    return () => incidents.command(desk, incident.id, input)
  },
  // Sin trabajador el plazo vencido ya rechaza el retiro. Registrarlo después no cambia la respuesta.
  'expiry-pending': async ({ lot }) => () => query(`UPDATE lots SET pickup_starts_at=now()-interval '3 hours',
    pickup_ends_at=now()-interval '1 second' WHERE public_id=$1`, [lot]),
  expiry: async context => {
    const pass = await closers['expiry-pending'](context)
    return async () => { await pass(); return expiries.expireLot(context.lot) }
  },
}

// Mismo esquema que K025. Cada contendiente debe quedar esperando el bloqueo antes de lanzar el siguiente.
async function lockedRace(lot, actions) {
  const pending = []
  let committed = false
  await gate.query('BEGIN')
  try {
    const [{ pid }] = (await gate.query('SELECT pg_backend_pid() AS pid')).rows
    await gate.query('SELECT id FROM lots WHERE public_id=$1 FOR UPDATE', [lot])
    const deadline = performance.now() + 1500
    for (const action of actions) {
      pending.push(settle(action()))
      let blocked = 0
      do {
        await gate.query('SELECT pg_stat_clear_snapshot()')
        blocked = (await gate.query(`WITH RECURSIVE waiting(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
          UNION
          SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid))
            WHERE a.datname=current_database()
        ) SELECT pid FROM waiting`, [pid])).rowCount
        if (blocked === pending.length) break
        await new Promise(resolve => setTimeout(resolve, 10))
      } while (performance.now() < deadline)
      assert.equal(blocked, pending.length, `deben esperar ${pending.length} transacciones del lote ${lot}`)
    }
    await gate.query('COMMIT')
    committed = true
    return await Promise.all(pending)
  } finally {
    if (!committed) await gate.query('ROLLBACK')
    await Promise.all(pending)
  }
}

try {
  await gate.connect()
  establishment = (await query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('K049','Santiago',-33.45,-70.66,'America/Santiago') RETURNING id::text`))[0].id

  // Revisión válida y después cada vía de cierre. Confirmar relee bajo bloqueo y rechaza el código capturado.
  const expected = { cancel: 'cancelled', withdraw: 'cancelled', incident: 'cancelled', 'expiry-pending': 'expired', expiry: 'expired' }
  for (const [path, status] of Object.entries(expected)) {
    const lot = await makeLot(2), holder = await person(), desk = await operator()
    const reservation = await reserve(holder, lot)
    const before = await reservations.reviewPickup(desk, lot, reservation.code, admit)
    assert.deepEqual([before.reservation.id, before.reservation.status, before.canConfirm], [reservation.id, 'confirmed', true])
    await (await closers[path]({ lot, holder, reservation, desk }))()
    const after = await reservations.reviewPickup(desk, lot, reservation.code, admit)
    assert.deepEqual([after.reservation.id, after.reservation.status, after.canConfirm], [reservation.id, status, false])
    await assert.rejects(deliver(desk, lot, reservation), { reason: status })
    assert.equal(await deliveries(reservation.id), 0)
    assert.equal((await reservations.get(holder, reservation.id)).pickupCode, null)
    const state = await counters(lot)
    assert.deepEqual([state.r, state.e], [path === 'expiry-pending' ? 1 : 0, 0])
    invalidated.push(reservation.id)
    ok(`${label[path]} después de una revisión válida, confirmar falla con ${status} y no crea entrega`)
  }

  // Código antiguo. Reservar otra vez entrega un código nuevo y el anterior no habilita nada.
  {
    const lot = await makeLot(3), other = await makeLot(3), holder = await person(), desk = await operator()
    const old = await reserve(holder, lot)
    await reservations.cancel(holder, old.id)
    const renewed = await reserve(holder, lot)
    assert.notEqual(renewed.code, old.code)
    await assert.rejects(reservations.confirmPickup(desk, lot, renewed.id, old.code, randomUUID(), admit),
      { code: 'pickup_code_not_found' })
    await assert.rejects(reservations.reviewPickup(desk, other, old.code, admit), { code: 'pickup_code_not_found' })
    const review = await reservations.reviewPickup(desk, lot, old.code, admit)
    assert.deepEqual([review.reservation.id, review.reservation.status, review.canConfirm], [old.id, 'cancelled', false])
    await assert.rejects(reservations.confirmPickup(desk, lot, old.id, renewed.code, randomUUID(), admit),
      { code: 'pickup_code_not_found' })
    const delivered = await deliver(desk, lot, renewed)
    assert.equal(delivered.reservationId, renewed.id)
    assert.equal((await reservations.get(holder, old.id)).status, 'cancelled')
    assert.deepEqual([await deliveries(old.id), await deliveries(renewed.id)], [0, 1])
    invalidated.push(old.id)
    ok('código antiguo rechazado en la reserva nueva y en otro lote; la revisión muestra la cancelada y no la reactiva')
  }

  // Dos operadores, un reintento y una vía de cierre compiten por el lote, en ambos órdenes.
  const ROUNDS = 5
  const tally = {}
  for (const path of ['cancel', 'withdraw', 'incident']) {
    for (const deliveryFirst of [true, false]) {
      for (let round = 1; round <= ROUNDS; round++) {
        const lot = await makeLot(2), holder = await person(), deskA = await operator(), deskB = await operator()
        const reservation = await reserve(holder, lot)
        const close = await closers[path]({ lot, holder, reservation, desk: deskA })
        const key = randomUUID()
        const pickups = [() => deliver(deskA, lot, reservation, key), () => deliver(deskA, lot, reservation, key),
          () => deliver(deskB, lot, reservation)]
        const results = await lockedRace(lot, deliveryFirst ? [...pickups, close] : [close, ...pickups])
        const [first, retry, rival, closed] = deliveryFirst ? results : [...results.slice(1), results[0]]
        const state = await counters(lot)
        if (deliveryFirst) {
          assert.ok(first.value, JSON.stringify(first.error?.message))
          assert.deepEqual(retry.value, first.value)
          assert.equal(rival.error?.reason, 'delivered')
          if (path === 'cancel') assert.equal(closed.error?.reason, 'delivered')
          else assert.ok(closed.value, JSON.stringify(closed.error?.message))
          assert.equal(await deliveries(reservation.id), 1)
        } else {
          assert.ok(closed.value, JSON.stringify(closed.error?.message))
          for (const attempt of [first, retry, rival]) assert.equal(attempt.error?.reason, 'cancelled')
          assert.equal(await deliveries(reservation.id), 0)
          invalidated.push(reservation.id)
        }
        const closedLot = path !== 'cancel'
        assert.deepEqual(state, {
          status: closedLot ? 'withdrawn' : 'published', f: closedLot ? 0 : deliveryFirst ? 1 : 2, o: 0, r: 0,
          e: deliveryFirst ? 1 : 0, x: closedLot ? (deliveryFirst ? 1 : 2) : 0,
        })
        const winner = deliveryFirst ? 'entrega' : label[path]
        tally[`${path}/${winner}`] = (tally[`${path}/${winner}`] ?? 0) + 1
        console.log(`RACE K049 ${label[path]} ${deliveryFirst ? 'entrega primero' : 'cierre primero'} ${round}/${ROUNDS}: `
          + `4 bloqueos observados, gana ${winner} con E=${state.e}`)
      }
    }
    ok(`${label[path]} contra dos operadores y un reintento en ${ROUNDS * 2} carreras, una entrega o ninguna según el orden, `
      + 'el reintento repite la respuesta y el rival recibe delivered o cancelled')
  }
  assert.ok(Object.values(tally).every(n => n === ROUNDS))

  // Conciliación final de todo lo creado por la suite.
  const unreconciled = await query(`SELECT l.public_id FROM lots l WHERE l.establishment_id=$1 AND (
       l.quantity <> l.free_quantity + l.offered_quantity + l.reserved_quantity + l.delivered_quantity + l.expired_quantity
    OR LEAST(l.free_quantity, l.offered_quantity, l.reserved_quantity, l.delivered_quantity, l.expired_quantity) < 0
    OR l.reserved_quantity <> COALESCE((SELECT sum(c.quantity) FROM commitments c WHERE c.lot_id=l.id AND c.status='confirmed'), 0)
    OR l.delivered_quantity <> COALESCE((SELECT sum(d.quantity) FROM deliveries d JOIN commitments c ON c.id=d.commitment_id
      WHERE c.lot_id=l.id), 0)
    OR l.status IN ('expired','withdrawn') AND l.free_quantity + l.offered_quantity + l.reserved_quantity <> 0
    OR EXISTS (SELECT 1 FROM commitments c WHERE c.lot_id=l.id
      AND (SELECT count(*) FROM deliveries d WHERE d.commitment_id=c.id) <> CASE WHEN c.status='delivered' THEN 1 ELSE 0 END)
    OR EXISTS (SELECT 1 FROM commitments c WHERE c.lot_id=l.id AND c.status <> 'confirmed' AND c.pickup_code_ciphertext IS NOT NULL))`,
  [establishment])
  assert.deepEqual(unreconciled, [])
  const credited = await query(`SELECT count(*)::int n FROM deliveries d JOIN commitments c ON c.id=d.commitment_id
    WHERE c.public_id = ANY($1::uuid[])`, [invalidated])
  assert.equal(credited[0].n, 0)
  ok(`inventario conciliado con Q = F + O + R + E + X sin negativos, entregas únicas y ${invalidated.length} códigos invalidados sin retiro`)
  console.log(`PASS K049: ${checks} grupos con PostgreSQL real`)
} finally {
  await gate.query('ROLLBACK').catch(() => {})
  await gate.end().catch(() => {})
  await pool.end()
}
