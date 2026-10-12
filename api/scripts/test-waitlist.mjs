// K027: cola FIFO, ofertas parciales, aceptación, rechazo y vencimiento contra PostgreSQL real.
// Usa una base aislada y ya migrada; los comandos pasan por la API real y el contrato OpenAPI.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { assertContract } from '../test/support/openapi.ts'
import { createApi } from '../dist/composition.js'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createPickupCodes } from '../dist/infrastructure/crypto/pickup-codes.js'
import { createWaitlistRepository } from '../dist/infrastructure/postgres/waitlist-repository.js'
import { createWaitlistUseCases } from '../dist/application/waitlist/use-cases.js'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_k027_test_/.test(new URL(connectionString).pathname.slice(1)),
  'Se requiere base de prueba aislada K027')
const pickupKey = randomBytes(32)
const database = new pg.Client({ connectionString })
const api = createApi({ ...process.env, RESCATE_ALLOWED_ORIGINS: 'https://localhost:5173',
  CSRF_SIGNING_KEY: randomBytes(32).toString('base64'), PICKUP_CODE_KEY: pickupKey.toString('base64') })
const server = api.app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let checks = 0
const ok = label => console.log(`OK ${++checks}: ${label}`)

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
    return { status: response.status, body: result }
  }
}
async function person(label) {
  const call = client()
  await call('GET', '/auth/session')
  const email = `k027-${label}-${randomUUID()}@example.invalid`
  assert.equal((await call('POST', '/auth/register', { email, password: 'Clave-ficticia-K027-segura', privacyConsent: true })).status, 201)
  assert.equal((await call('POST', '/auth/login', { email, password: 'Clave-ficticia-K027-segura' })).status, 200)
  const { rows } = await database.query('SELECT id::text FROM users WHERE email = $1', [email])
  return { call, userId: rows[0].id }
}

const pool = createPool({ connectionString })
const codes = createPickupCodes(pickupKey)
const waitlist = createWaitlistUseCases(createWaitlistRepository(pool), codes, () => new Date())

try {
  await database.connect()
  const establishment = (await database.query(`INSERT INTO establishments
    (name, address, latitude, longitude, time_zone) VALUES ('K027 Norte', 'Santiago', -33.45, -70.66, 'America/Santiago')
    RETURNING id`)).rows[0].id
  // Por defecto la ventana ya comenzó y cierra en dos horas.
  const makeLot = async (quantity, starts = '-1 hour', ends = '2 hours') =>
    (await database.query(`INSERT INTO lots (establishment_id, description, category, quantity, address, latitude,
       longitude, time_zone, pickup_starts_at, pickup_ends_at, status, published_at)
     VALUES ($1, 'Pack K027', 'Panadería', $2, 'Santiago Centro', -33.45, -70.66, 'America/Santiago',
       now() + $3::interval, now() + $4::interval, 'published', now() - interval '2 hours')
     RETURNING public_id::text AS id`, [establishment, quantity, starts, ends])).rows[0].id
  const counters = async lotId => (await database.query(`SELECT free_quantity AS f, offered_quantity AS o,
      reserved_quantity AS r, delivered_quantity AS e, expired_quantity AS x FROM lots WHERE public_id = $1`, [lotId])).rows[0]
  const stored = async entryId => (await database.query(
    'SELECT status, offered_quantity, ended_at FROM waitlist_entries WHERE public_id = $1', [entryId])).rows[0]
  const reserve = (who, lot, quantity) => who.call('POST', `/public/lots/${lot}/reservations`, { quantity, idempotencyKey: randomUUID() })
  const join = (who, lot, quantity, idempotencyKey = randomUUID()) =>
    who.call('POST', `/public/lots/${lot}/waitlist`, { quantity, idempotencyKey })
  const command = (who, entry, name) => who.call('POST', `/waitlist/${entry}/${name}`, {})
  const view = async (who, entry) => (await who.call('GET', `/waitlist/${entry}`)).body

  const ana = await person('ana')
  const pedro = await person('pedro')
  const juan = await person('juan')
  const luis = await person('luis')
  const marta = await person('marta')

  // --- ADR 0002: Ana 10, Pedro 3, Juan 1 con 4 libres. La cabeza recibe 4 y nadie la adelanta.
  const lot = await makeLot(10)
  assert.equal((await reserve(luis, lot, 6)).status, 201)
  const first = await join(ana, lot, 10)
  assert.equal(first.status, 201)
  assert.equal(first.body.status, 'offered')
  assert.equal(first.body.requestedQuantity, 10)
  assert.equal(first.body.offeredQuantity, 4)
  assert.equal(first.body.position, null)
  const offerMs = Date.parse(first.body.offerExpiresAt) - Date.now()
  assert.ok(offerMs > 9 * 60_000 && offerMs <= 10 * 60_000, 'la oferta dura diez minutos')
  assert.deepEqual(await counters(lot), { f: 0, o: 4, r: 6, e: 0, x: 0 })
  const second = await join(pedro, lot, 3)
  const third = await join(juan, lot, 1)
  assert.deepEqual([second.body.status, second.body.position], ['waiting', 1])
  assert.deepEqual([third.body.status, third.body.position], ['waiting', 2])
  assert.deepEqual(await counters(lot), { f: 0, o: 4, r: 6, e: 0, x: 0 })
  assert.equal((await reserve(marta, lot, 1)).status, 409)
  ok('la cabeza recibe una oferta parcial de 4 sobre 10; la espera no retiene packs y nadie adelanta')

  // --- Aceptar confirma solo lo ofrecido (O → R) y cierra la solicitud sin saldo.
  const accepted = await command(ana, first.body.id, 'accept')
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.status, 'accepted')
  assert.equal(accepted.body.offeredQuantity, 4)
  assert.equal(accepted.body.requestedQuantity, 10)
  assert.ok(accepted.body.reservationId && accepted.body.endedAt)
  assert.deepEqual(await counters(lot), { f: 0, o: 0, r: 10, e: 0, x: 0 })
  const reservation = (await ana.call('GET', `/reservations/${accepted.body.reservationId}`)).body
  assert.equal(reservation.quantity, 4)
  assert.equal(reservation.status, 'confirmed')
  assert.match(reservation.pickupCode, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  const replay = await command(ana, first.body.id, 'accept')
  assert.equal(replay.status, 200)
  assert.equal(replay.body.reservationId, accepted.body.reservationId)
  assert.deepEqual(await counters(lot), { f: 0, o: 0, r: 10, e: 0, x: 0 })
  assert.equal((await database.query(`SELECT count(*)::int AS n FROM commitments c JOIN lots l ON l.id = c.lot_id
    WHERE l.public_id = $1 AND c.user_id = $2`, [lot, ana.userId])).rows[0].n, 1)
  assert.equal((await command(ana, first.body.id, 'decline')).status, 409)
  assert.equal((await join(ana, lot, 6)).status, 409)
  assert.deepEqual([(await view(pedro, second.body.id)).position, (await view(juan, third.body.id)).position], [1, 2])
  ok('aceptar confirma 4 (O → R), repetirlo devuelve la misma reserva, no queda saldo y volver a pedir con la reserva activa es 409')

  // --- Cancelar la reserva libera packs: se ofrecen en orden, la cabeza parcial incluida.
  assert.equal((await luis.call('GET', '/reservations')).body.items.length, 1)
  const luisReservation = (await luis.call('GET', '/reservations')).body.items[0].id
  assert.equal((await luis.call('POST', `/reservations/${luisReservation}/cancel`, {})).status, 200)
  const pedroOffer = await view(pedro, second.body.id)
  const juanOffer = await view(juan, third.body.id)
  assert.deepEqual([pedroOffer.status, pedroOffer.offeredQuantity], ['offered', 3])
  assert.deepEqual([juanOffer.status, juanOffer.offeredQuantity], ['offered', 1])
  assert.deepEqual(await counters(lot), { f: 2, o: 4, r: 4, e: 0, x: 0 })
  ok('cancelar una reserva ofrece lo liberado a quienes esperan, en orden FIFO y bajo el mismo bloqueo')

  // --- Rechazar libera solo lo retenido y no reingresa ni conserva prioridad.
  const declined = await command(pedro, second.body.id, 'decline')
  assert.equal(declined.status, 200)
  assert.equal(declined.body.status, 'declined')
  assert.deepEqual(await counters(lot), { f: 5, o: 1, r: 4, e: 0, x: 0 })
  assert.equal((await command(pedro, second.body.id, 'decline')).status, 200)
  assert.deepEqual(await counters(lot), { f: 5, o: 1, r: 4, e: 0, x: 0 })
  assert.equal((await command(pedro, second.body.id, 'accept')).status, 409)
  assert.equal((await join(pedro, lot, 3)).status, 409)
  const rejoin = await join(pedro, lot, 9)
  assert.equal(rejoin.status, 201)
  assert.deepEqual([rejoin.body.status, rejoin.body.offeredQuantity], ['offered', 5])
  assert.notEqual(rejoin.body.id, second.body.id)
  assert.deepEqual(await counters(lot), { f: 0, o: 6, r: 4, e: 0, x: 0 })
  ok('rechazar libera solo lo retenido (repetirlo no libera otra vez); reingresar exige una solicitud nueva sin prioridad heredada')

  // --- Vencer: una oferta sin respuesta deja de poder aceptarse aunque nadie la haya registrado.
  await database.query(`UPDATE waitlist_entries SET offered_at = offered_at - interval '1 hour',
    offer_expires_at = offer_expires_at - interval '1 hour' WHERE public_id = $1`, [third.body.id])
  const lapsed = await view(juan, third.body.id)
  assert.equal(lapsed.status, 'expired')
  assert.ok(lapsed.endedAt)
  assert.equal((await stored(third.body.id)).status, 'offered')
  const late = await command(juan, third.body.id, 'accept')
  assert.equal(late.status, 409)
  assert.equal((await stored(third.body.id)).status, 'expired')
  assert.deepEqual(await counters(lot), { f: 1, o: 5, r: 4, e: 0, x: 0 })
  assert.equal((await command(juan, third.body.id, 'accept')).status, 409)
  // Con la cola vacía y libres suficientes corresponde reservar directamente.
  assert.equal((await join(juan, lot, 1)).status, 409)
  ok('una oferta vencida no se acepta sin trabajador; el intento registra el vencimiento y libera solo lo retenido a F')

  // --- El trabajador (K028/K031) registra por tandas lo vencido y ofrece lo liberado.
  const rejoined = await view(pedro, rejoin.body.id)
  assert.equal(rejoined.status, 'offered')
  await database.query(`UPDATE waitlist_entries SET offered_at = offered_at - interval '1 hour',
    offer_expires_at = offer_expires_at - interval '1 hour' WHERE public_id = $1`, [rejoin.body.id])
  const queued = await makeLot(4)
  assert.equal((await reserve(luis, queued, 4)).status, 201)
  const waiting = await join(marta, queued, 2)
  assert.deepEqual([waiting.body.status, waiting.body.position], ['waiting', 1])
  assert.ok(await waitlist.settleDue(50) >= 1)
  assert.equal((await stored(rejoin.body.id)).status, 'expired')
  assert.deepEqual(await counters(lot), { f: 6, o: 0, r: 4, e: 0, x: 0 })
  assert.equal(await waitlist.settleDue(50), 0)
  ok('settleDue registra vencimientos una sola vez y repetirlo no cambia nada')

  // --- Salir de la cola: solo quien espera, sin packs que liberar.
  const leaver = await person('salida')
  const stay = await person('permanece')
  const crowded = await makeLot(2)
  assert.equal((await reserve(luis, crowded, 2)).status, 201)
  const left = await join(leaver, crowded, 1)
  const stays = await join(stay, crowded, 1)
  assert.deepEqual([left.body.position, stays.body.position], [1, 2])
  const exit = await command(leaver, left.body.id, 'leave')
  assert.equal(exit.status, 200)
  assert.deepEqual([exit.body.status, exit.body.position], ['left', null])
  assert.equal((await command(leaver, left.body.id, 'leave')).status, 200)
  assert.equal((await view(stay, stays.body.id)).position, 1)
  assert.equal((await command(leaver, left.body.id, 'accept')).status, 409)
  assert.deepEqual(await counters(crowded), { f: 0, o: 0, r: 2, e: 0, x: 0 })
  ok('salir de la cola es idempotente, solo para quien espera, y el resto avanza de posición')

  // --- Ofertas con plazo: diez minutos o el cierre; con menos de un minuto no se ofrece.
  const short = await makeLot(2, '-1 hour', '5 minutes')
  assert.equal((await reserve(luis, short, 2)).status, 201)
  const shortEntry = await join(ana, short, 1)
  assert.equal(shortEntry.body.status, 'waiting')
  const luisShort = (await luis.call('GET', '/reservations')).body.items.find(item => item.lot.id === short)
  assert.equal((await luis.call('POST', `/reservations/${luisShort.id}/cancel`, {})).status, 200)
  const shortOffer = await view(ana, shortEntry.body.id)
  assert.equal(shortOffer.status, 'offered')
  assert.equal(shortOffer.offerExpiresAt, shortOffer.lot.pickupEndsAt)
  const closing = await makeLot(2, '-1 hour', '30 seconds')
  assert.equal((await reserve(luis, closing, 2)).status, 201)
  const closingEntry = await join(pedro, closing, 1)
  const luisClosing = (await luis.call('GET', '/reservations')).body.items.find(item => item.lot.id === closing)
  assert.equal((await luis.call('POST', `/reservations/${luisClosing.id}/cancel`, {})).status, 200)
  assert.equal((await view(pedro, closingEntry.body.id)).status, 'waiting')
  assert.deepEqual(await counters(closing), { f: 2, o: 0, r: 0, e: 0, x: 0 })
  ok('la oferta dura hasta el cierre si este llega antes de diez minutos y no se ofrece con menos de un minuto')

  // --- Cierre del lote: la espera termina sin ofertas y lo retenido pasa a X.
  const ending = await makeLot(3)
  assert.equal((await reserve(luis, ending, 2)).status, 201)
  const heldOffer = await join(ana, ending, 3)
  assert.deepEqual([heldOffer.body.status, heldOffer.body.offeredQuantity], ['offered', 1])
  const behind = await join(pedro, ending, 1)
  assert.equal(behind.body.status, 'waiting')
  await database.query(`UPDATE lots SET pickup_starts_at = now() - interval '3 hours',
    pickup_ends_at = now() - interval '1 minute' WHERE public_id = $1`, [ending])
  assert.equal((await view(ana, heldOffer.body.id)).status, 'expired')
  assert.equal((await view(pedro, behind.body.id)).status, 'expired')
  assert.equal((await command(ana, heldOffer.body.id, 'accept')).status, 409)
  // El intento registra el cierre: la oferta pasa a X y la espera termina en la misma transacción.
  assert.deepEqual(await counters(ending), { f: 0, o: 0, r: 2, e: 0, x: 1 })
  assert.equal((await stored(heldOffer.body.id)).status, 'expired')
  assert.equal((await join(marta, ending, 1)).status, 409)
  await waitlist.settleDue(50)
  assert.equal((await stored(behind.body.id)).status, 'expired')
  assert.equal((await database.query(`SELECT count(*)::int AS n FROM waitlist_entries w JOIN lots l ON l.id = w.lot_id
    WHERE l.public_id = $1 AND w.status IN ('waiting', 'offered')`, [ending])).rows[0].n, 0)
  ok('al cerrar el lote la oferta pasa a X, la espera termina sin prioridad y no se admiten solicitudes nuevas')

  // --- Idempotencia, validación y propiedad.
  const idem = await makeLot(1)
  assert.equal((await reserve(luis, idem, 1)).status, 201)
  const key = randomUUID()
  const once = await join(marta, idem, 1, key)
  const again = await join(marta, idem, 1, key)
  assert.equal(once.status, 201)
  assert.equal(again.body.id, once.body.id)
  assert.equal((await join(marta, idem, 1, randomUUID())).status, 409)
  assert.equal((await join(marta, await makeLot(1), 1, key)).status, 409)
  assert.equal((await join(marta, idem, 2, key)).status, 409)
  assert.equal((await database.query(`SELECT count(*)::int AS n FROM waitlist_entries WHERE user_id = $1 AND idempotency_key = $2`,
    [marta.userId, key])).rows[0].n, 1)
  assert.equal((await join(ana, idem, 0)).status, 422)
  assert.equal((await ana.call('POST', `/public/lots/${idem}/waitlist`, { quantity: 1 })).status, 422)
  assert.equal((await join(ana, randomUUID(), 1)).status, 404)
  assert.equal((await join(ana, idem, 2)).status, 409)
  assert.equal((await command(pedro, once.body.id, 'leave')).status, 404)
  assert.equal((await pedro.call('GET', `/waitlist/${once.body.id}`)).status, 404)
  assert.equal((await ana.call('GET', `/waitlist/${randomUUID()}`)).status, 404)
  assert.equal((await client()('GET', '/waitlist')).status, 401)
  assert.equal((await marta.call('POST', `/waitlist/${once.body.id}/leave`, { extra: true })).status, 422)
  const direct = await makeLot(5)
  assert.equal((await join(ana, direct, 3)).status, 409)
  const full = await makeLot(2)
  assert.equal((await reserve(luis, full, 2)).status, 201)
  assert.equal((await join(ana, full, 3)).status, 409)
  ok('idempotencia por clave, validación, propiedad (404), sesión y reserva directa cuando alcanza')

  // --- Un usuario con una solicitud abierta no puede reservar directamente el mismo lote.
  const open = await makeLot(2)
  assert.equal((await reserve(luis, open, 2)).status, 201)
  const holder = await person('solicitante')
  assert.equal((await join(holder, open, 1)).status, 201)
  assert.equal((await reserve(holder, open, 1)).status, 409)
  ok('una solicitud abierta cuenta como compromiso activo del lote (RF04)')

  // --- Carreras: ingresos simultáneos y aceptaciones simultáneas.
  const racing = await makeLot(1)
  assert.equal((await reserve(luis, racing, 1)).status, 201)
  // Registrar es costoso a propósito (hashing acotado): las personas se crean en serie y compiten después.
  const racers = []
  for (const label of ['a', 'b', 'c', 'd']) racers.push(await person(`carrera-${label}`))
  const joined = await Promise.all(racers.map(racer => join(racer, racing, 1)))
  assert.ok(joined.every(result => result.status === 201))
  assert.deepEqual(joined.map(result => result.body.position).sort(), [1, 2, 3, 4])
  const luisRacing = (await luis.call('GET', '/reservations')).body.items.find(item => item.lot.id === racing)
  assert.equal((await luis.call('POST', `/reservations/${luisRacing.id}/cancel`, {})).status, 200)
  const states = await Promise.all(racers.map((racer, index) => view(racer, joined[index].body.id)))
  const winner = joined.findIndex(result => result.body.position === 1)
  assert.deepEqual(states.map(state => state.status), states.map((_, index) => index === winner ? 'offered' : 'waiting'))
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => command(racers[winner], joined[winner].body.id, 'accept')))
  assert.ok(results.every(result => result.status === 200))
  assert.equal(new Set(results.map(result => result.body.reservationId)).size, 1)
  assert.deepEqual(await counters(racing), { f: 0, o: 0, r: 1, e: 0, x: 0 })
  const decisions = await Promise.all([command(racers[(winner + 1) % 4], joined[(winner + 1) % 4].body.id, 'leave'),
    command(racers[(winner + 1) % 4], joined[(winner + 1) % 4].body.id, 'leave'),
    command(racers[(winner + 2) % 4], joined[(winner + 2) % 4].body.id, 'leave')])
  assert.ok(decisions.every(result => result.status === 200))
  ok('ingresos simultáneos reciben posiciones distintas; cinco aceptaciones crean una sola reserva')

  // --- Conciliación: Q = F + O + R + E + X; O y R coinciden con sus registros.
  const unreconciled = await database.query(`SELECT l.public_id FROM lots l
    WHERE l.quantity <> l.free_quantity + l.offered_quantity + l.reserved_quantity + l.delivered_quantity + l.expired_quantity
       OR LEAST(l.free_quantity, l.offered_quantity, l.reserved_quantity, l.delivered_quantity, l.expired_quantity) < 0
       OR l.reserved_quantity <> COALESCE((SELECT sum(c.quantity) FROM commitments c WHERE c.lot_id = l.id AND c.status = 'confirmed'), 0)
       OR l.offered_quantity <> COALESCE((SELECT sum(w.offered_quantity) FROM waitlist_entries w WHERE w.lot_id = l.id AND w.status = 'offered'), 0)
       OR EXISTS (SELECT 1 FROM waitlist_entries w WHERE w.lot_id = l.id AND w.status = 'waiting'
         AND l.free_quantity > 0 AND l.status = 'published' AND l.pickup_ends_at > now() + interval '1 minute')
       OR EXISTS (SELECT 1 FROM waitlist_entries w WHERE w.lot_id = l.id AND w.status = 'accepted'
         AND w.offered_quantity <> (SELECT c.quantity FROM commitments c WHERE c.id = w.commitment_id))`)
  assert.deepEqual(unreconciled.rows, [])
  console.log(`PASS K027: ${checks} grupos de integración con PostgreSQL real`)
} finally {
  await database.end().catch(() => {})
  await pool.end()
  await new Promise(resolve => server.close(resolve))
  await api.close()
}
