// K035: panel del establecimiento contra PostgreSQL real. Los totales se contrastan con
// commitments, deliveries y waitlist_entries; dos establecimientos no se mezclan.
// Usa una base aislada y ya migrada; los cierres se fijan moviendo las ventanas por SQL.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { assertContract } from '../test/support/openapi.ts'
import { createApi } from '../dist/composition.js'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createExpiryUseCases } from '../dist/application/expiries/use-cases.js'
import { createLotExpiryRepository } from '../dist/infrastructure/postgres/expiry-repository.js'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_(k035_test_|web_test_)/.test(new URL(connectionString).pathname.slice(1)),
  'Se requiere base de prueba aislada K035 o web')
const database = new pg.Client({ connectionString })
const api = createApi({ ...process.env, RESCATE_ALLOWED_ORIGINS: 'https://localhost:5173',
  CSRF_SIGNING_KEY: randomBytes(32).toString('base64'), PICKUP_CODE_KEY: randomBytes(32).toString('base64') })
const server = api.app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const pool = createPool({ connectionString })
const expiries = createExpiryUseCases(createLotExpiryRepository(pool), () => {})
let checks = 0
const ok = label => console.log(`OK ${++checks}: ${label}`)
const issuedCodes = new Set()

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
  const email = `k035-${label}-${randomUUID()}@example.invalid`
  assert.equal((await call('POST', '/auth/register', { email, password: 'Clave-ficticia-K035-segura', privacyConsent: true })).status, 201)
  assert.equal((await call('POST', '/auth/login', { email, password: 'Clave-ficticia-K035-segura' })).status, 200)
  const { rows } = await database.query('SELECT id::text FROM users WHERE email = $1', [email])
  return { call, userId: rows[0].id, email }
}

try {
  await database.connect()
  const establishment = async name => (await database.query(`INSERT INTO establishments
    (name, address, latitude, longitude, time_zone) VALUES ($1, 'Santiago', -33.45, -70.66, 'America/Santiago')
    RETURNING id, public_id::text AS "publicId"`, [name])).rows[0]
  const north = await establishment('K035 Norte')
  const south = await establishment('K035 Sur')
  // Ventana abierta: comenzó hace una hora y cierra en dos.
  const makeLot = async (quantity, owner = north, status = 'published') =>
    (await database.query(`INSERT INTO lots (establishment_id, description, category, quantity, address, latitude,
       longitude, time_zone, pickup_starts_at, pickup_ends_at, status, published_at)
     VALUES ($1, $2, 'Panadería', $3, 'Santiago Centro', -33.45, -70.66, 'America/Santiago',
       now() - interval '1 hour', now() + interval '2 hours', $4::lot_status, CASE WHEN $4 = 'draft' THEN NULL ELSE now() - interval '2 hours' END)
     RETURNING public_id::text AS id`, [owner.id, `Pack K035 ${quantity}`, quantity, status])).rows[0].id
  // Cierra la ventana en un instante fijo del pasado, sin registrar el cierre.
  const closeWindowAt = (lotId, endsAt) => database.query(`UPDATE lots SET pickup_starts_at = $2::timestamptz - interval '3 hours',
    pickup_ends_at = $2::timestamptz WHERE public_id = $1`, [lotId, endsAt])

  const operator = await person('operador')
  const outsider = await person('otro-local')
  // En secuencia: el registro limita los cálculos de contraseña simultáneos (503).
  const ana = await person('ana')
  const beto = await person('beto')
  const carla = await person('carla')
  const dani = await person('dani')
  await database.query('INSERT INTO memberships (user_id, establishment_id) VALUES ($1, $2), ($3, $4)',
    [operator.userId, north.id, outsider.userId, south.id])
  const reserve = async (who, lot, quantity) => {
    const result = await who.call('POST', `/public/lots/${lot}/reservations`, { quantity, idempotencyKey: randomUUID() })
    assert.equal(result.status, 201)
    // Consultar el detalle registra el código emitido para buscarlo luego en el panel.
    assert.match((await who.call('GET', `/reservations/${result.body.id}`)).body.pickupCode, /^[0-9A-Z]{8}$/)
    return result.body.id
  }
  const deliver = async (who, lot, reservationId, as = operator) => {
    const code = (await who.call('GET', `/reservations/${reservationId}`)).body.pickupCode
    assert.equal((await as.call('POST', `/lots/${lot}/pickups`, { reservationId, code, idempotencyKey: randomUUID() })).status, 201)
  }
  const join = async (who, lot, quantity) => {
    const result = await who.call('POST', `/public/lots/${lot}/waitlist`, { quantity, idempotencyKey: randomUUID() })
    assert.equal(result.status, 201)
    return result.body
  }

  // --- Lote A: 6 packs; 2 retirados, 1 cancelado y 1 que vence con el cierre registrado.
  const lotA = await makeLot(6)
  await deliver(ana, lotA, await reserve(ana, lotA, 2))
  assert.equal((await beto.call('POST', `/reservations/${await reserve(beto, lotA, 1)}/cancel`, {})).status, 200)
  await reserve(carla, lotA, 1)
  // --- Lote B: 3 packs; Ana toma todo, Beto espera, Ana cancela y Beto acepta la oferta.
  const lotB = await makeLot(3)
  const anaB = await reserve(ana, lotB, 3)
  const betoEntry = await join(beto, lotB, 2)
  assert.equal(betoEntry.status, 'waiting')
  assert.equal((await ana.call('POST', `/reservations/${anaB}/cancel`, {})).status, 200)
  const accepted = await beto.call('POST', `/waitlist/${betoEntry.id}/accept`, {})
  assert.deepEqual([accepted.status, accepted.body.status], [200, 'accepted'])
  assert.equal((await beto.call('GET', `/reservations/${accepted.body.reservationId}`)).status, 200)
  // 23:30 del 9 de enero y 00:30 del 10 en Santiago (UTC-3): en UTC ambos son el 10.
  await closeWindowAt(lotA, '2026-01-10T02:30:00Z')
  await closeWindowAt(lotB, '2026-01-10T03:30:00Z')
  // El trabajador registra solo el cierre más antiguo (A); B queda cerrado sin registro.
  assert.equal(await expiries.expireNext(), true)
  const registered = (await database.query(`SELECT public_id::text AS id, status::text, closed_at FROM lots
    WHERE public_id = ANY($1) ORDER BY pickup_ends_at`, [[lotA, lotB]])).rows
  assert.deepEqual(registered.map(row => row.status), ['expired', 'published'])

  // --- Lote C abierto: reserva vigente, oferta parcial vigente y una persona esperando.
  const lotC = await makeLot(5)
  await reserve(ana, lotC, 2)
  const carlaEntry = await join(carla, lotC, 4)
  assert.deepEqual([carlaEntry.status, carlaEntry.offeredQuantity], ['offered', 3])
  const daniEntry = await join(dani, lotC, 1)
  assert.equal(daniEntry.status, 'waiting')
  // --- Lote D en borrador y lotes del otro establecimiento con entregas en el mismo período.
  await makeLot(4, north, 'draft')
  const lotS = await makeLot(7, south)
  await deliver(dani, lotS, await reserve(dani, lotS, 5), outsider)
  await makeLot(9, south)
  await closeWindowAt(lotS, '2026-01-10T02:00:00Z')
  ok('escenario: dos establecimientos, cierre registrado y sin registrar, oferta aceptada, cola y borrador')

  // --- Acceso: solo el operador del establecimiento; otro local y titulares 403 sin datos.
  const panelPath = (owner, query = '') => `/establishments/${owner.publicId}/panel${query}`
  for (const path of [panelPath(north), `/establishments/${north.publicId}/commitments`, `/establishments/${north.publicId}/activity`]) {
    assert.equal((await outsider.call('GET', path)).status, 403)
    assert.equal((await ana.call('GET', path)).status, 403)
    assert.equal((await client()('GET', path)).status, 401)
  }
  assert.equal((await operator.call('GET', `/establishments/${randomUUID()}/panel`)).status, 404)
  assert.equal((await operator.call('GET', `/establishments/${north.publicId}/activity?lotId=${lotS}`)).status, 404)
  assert.equal((await operator.call('GET', `/establishments/${north.publicId}/commitments?lotId=${lotS}`)).status, 404)
  ok('panel, compromisos e historial: otro establecimiento y titulares 403; lote ajeno 404; sin sesión 401')

  // --- Estado vigente: lote C con F/O/R/E/X que cuadra con sus registros.
  const now = await operator.call('GET', panelPath(north))
  assert.equal(now.status, 200)
  assert.deepEqual(now.body.current.lots.map(lot => lot.id), [lotC])
  assert.deepEqual(now.body.current.inventory, { free: 0, offered: 3, reserved: 2, delivered: 0, unassignable: 0 })
  assert.deepEqual([now.body.current.confirmedReservations, now.body.current.activeOffers, now.body.current.waitingRequests], [1, 1, 1])
  const [counters] = (await database.query(`SELECT quantity, free_quantity AS f, offered_quantity AS o, reserved_quantity AS r,
      delivered_quantity AS e, expired_quantity AS x FROM lots WHERE public_id = $1`, [lotC])).rows
  const inventory = now.body.current.lots[0].inventory
  assert.deepEqual([inventory.free, inventory.offered, inventory.reserved, inventory.delivered, inventory.unassignable],
    [counters.f, counters.o, counters.r, counters.e, counters.x])
  assert.equal(Object.values(inventory).reduce((a, b) => a + b, 0), counters.quantity)
  // Una oferta vencida sin registrar ya no retiene packs: vuelve a libres sin esperar al trabajador.
  await database.query(`UPDATE waitlist_entries SET offered_at = now() - interval '20 minutes',
    offer_expires_at = now() - interval '1 minute' WHERE public_id = $1`, [carlaEntry.id])
  const stale = await operator.call('GET', panelPath(north))
  assert.deepEqual(stale.body.current.inventory, { free: 3, offered: 0, reserved: 2, delivered: 0, unassignable: 0 })
  assert.equal(stale.body.current.activeOffers, 0)
  ok('estado vigente: inventario igual a los contadores, Q = F + O + R + E + X y oferta vencida sin registrar como libre')

  // --- Período en días de Santiago: A cerró el 9 y B el 10, aunque en UTC ambos sean el 10.
  const period = async query => (await operator.call('GET', panelPath(north, query))).body.period
  const day9 = await period('?from=2026-01-09&to=2026-01-09')
  assert.deepEqual([day9.closedLots, day9.packs], [1, { published: 6, delivered: 2, unassignable: 4 }])
  assert.deepEqual(day9.reservations, { confirmed: 3, cancelled: 1, expired: 1, delivered: 1 })
  assert.deepEqual(day9.deliveryRate, { numerator: 2, denominator: 6, value: 2 / 6 })
  assert.deepEqual(day9.reservationExpiryRate, { numerator: 1, denominator: 3, value: 1 / 3 })
  const day10 = await period('?from=2026-01-10&to=2026-01-10')
  // B cerró sin registro: la reserva aceptada sigue confirmada en la base y ya cuenta como vencida.
  assert.deepEqual([day10.closedLots, day10.packs], [1, { published: 3, delivered: 0, unassignable: 3 }])
  assert.deepEqual(day10.reservations, { confirmed: 2, cancelled: 1, expired: 1, delivered: 0 })
  const both = await period('?from=2026-01-09&to=2026-01-10')
  assert.deepEqual([both.closedLots, both.packs, both.reservations], [2, { published: 9, delivered: 2, unassignable: 7 },
    { confirmed: 5, cancelled: 2, expired: 2, delivered: 1 }])
  assert.deepEqual(both.excluded, { openLots: 1, draftLots: 1 })
  assert.equal((await period('?from=2026-01-11&to=2026-01-11')).closedLots, 0)
  assert.deepEqual((await period('?from=2026-01-11&to=2026-01-11')).deliveryRate, { numerator: 0, denominator: 0, value: null })
  assert.deepEqual([now.body.period.from, now.body.period.to].map(value => /^\d{4}-\d{2}-\d{2}$/.test(value)), [true, true])
  ok('período: días locales de Santiago, cierre sin registrar incluido, tasas con numerador y denominador y sin denominador null')

  // --- Cuadre con los registros: entregas y reservas de los lotes cerrados del norte, sin el sur.
  const [truth] = (await database.query(`SELECT
      (SELECT coalesce(sum(d.quantity), 0)::int FROM deliveries d JOIN commitments c ON c.id = d.commitment_id
        JOIN lots l ON l.id = c.lot_id WHERE l.public_id = ANY($1)) AS delivered,
      (SELECT count(*)::int FROM commitments c JOIN lots l ON l.id = c.lot_id WHERE l.public_id = ANY($1)) AS confirmed,
      (SELECT count(*)::int FROM deliveries) AS all_deliveries`, [[lotA, lotB]])).rows
  assert.equal(both.packs.delivered, truth.delivered)
  assert.equal(both.reservations.confirmed, truth.confirmed)
  assert.equal(both.reservations.cancelled + both.reservations.expired + both.reservations.delivered, both.reservations.confirmed)
  assert.equal(both.packs.delivered + both.packs.unassignable, both.packs.published)
  assert.equal(truth.all_deliveries, 2, 'el sur también entregó en el período y no entra en el norte')
  const southPanel = (await outsider.call('GET', panelPath(south, '?from=2026-01-09&to=2026-01-10'))).body
  assert.deepEqual([southPanel.period.closedLots, southPanel.period.packs], [1, { published: 7, delivered: 5, unassignable: 2 }])
  assert.deepEqual(southPanel.current.lots.length, 1)
  ok('cuadre: retirados = deliveries, reservas = commitments, términos suman confirmadas y el sur no se mezcla')

  // --- Compromisos: vigentes, terminados y por lote, con el estado vigente y sin titulares.
  const commitments = async query => (await operator.call('GET', `/establishments/${north.publicId}/commitments${query}`)).body
  const active = await commitments('?state=active')
  assert.deepEqual(active.items.map(item => [item.kind, item.status, item.lot.id]).sort(), [
    ['reservation', 'confirmed', lotC], ['waitlist', 'waiting', lotC]])
  const ofB = await commitments(`?lotId=${lotB}`)
  assert.deepEqual(ofB.items.map(item => [item.kind, item.status, item.quantity]).sort(), [
    ['reservation', 'cancelled', 3], ['reservation', 'expired', 2], ['waitlist', 'accepted', 2]])
  assert.equal(ofB.items.find(item => item.status === 'expired').endedAt, '2026-01-10T03:30:00.000Z')
  const ended = await commitments('?state=ended')
  assert.ok(ended.items.every(item => !['confirmed', 'waiting', 'offered'].includes(item.status)))
  assert.ok(ended.items.some(item => item.id === carlaEntry.id && item.status === 'expired'), 'la oferta vencida sin registrar ya terminó')
  assert.equal(active.items.length + ended.items.length, (await commitments('')).items.length)
  ok('compromisos: vigentes y terminados se reparten sin solaparse y muestran el estado vigente')

  // --- Historial: hechos por lote en orden, con oferta aceptada y cierres sin registrar.
  const activity = async query => (await operator.call('GET', `/establishments/${north.publicId}/activity${query}`)).body
  const kinds = items => items.map(item => item.kind)
  // El cierre y la reserva que vence con él son simultáneos: primero el cierre.
  const ofA = kinds((await activity(`?lotId=${lotA}`)).items)
  assert.equal(ofA.indexOf('lot_expired') + 1, ofA.indexOf('reservation_expired'))
  assert.deepEqual(kinds((await activity(`?lotId=${lotA}`)).items).sort(), ['lot_expired', 'lot_published', 'pickup_confirmed',
    'reservation_cancelled', 'reservation_confirmed', 'reservation_confirmed', 'reservation_confirmed', 'reservation_expired'])
  assert.deepEqual(kinds((await activity(`?lotId=${lotB}`)).items).sort(), ['lot_expired', 'lot_published', 'offer_accepted',
    'offer_issued', 'reservation_cancelled', 'reservation_confirmed', 'reservation_expired', 'waitlist_joined'])
  const all = await activity('')
  assert.equal(all.items.length, 20)
  assert.equal(all.hasNextPage, true)
  const next = await activity('?page=2')
  const times = [...all.items, ...next.items].map(item => Date.parse(item.at))
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'más recientes primero')
  assert.equal(new Set([...all.items, ...next.items].map(item => item.id)).size, all.items.length + next.items.length)
  assert.ok([...all.items, ...next.items].every(item => [lotA, lotB, lotC].includes(item.lot.id)), 'sin borradores ni lotes ajenos')
  ok('historial: hechos del lote, oferta aceptada una sola vez, orden descendente, páginas sin repetir y sin lotes ajenos')

  // --- Ninguna respuesta del panel contiene códigos ni correos de titulares.
  const bodies = JSON.stringify([now.body, stale.body, both, active, ofB, ended, all, next])
  assert.equal(issuedCodes.size, 7)
  for (const code of issuedCodes) assert.ok(!bodies.includes(code), 'sin códigos de retiro')
  for (const who of [ana, beto, carla, dani]) assert.ok(!bodies.includes(who.email) && !bodies.includes(`"${who.userId}"`), 'sin titulares')
  ok('las respuestas no contienen códigos de retiro, correos ni IDs de titulares')
  console.log(`K035 panel: ${checks} comprobaciones OK`)
} finally {
  await new Promise(resolve => server.close(resolve))
  await api.close()
  await pool.end()
  await database.end()
}
