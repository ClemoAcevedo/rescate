// K030: avisos internos y outbox contra PostgreSQL real. Usa una base aislada y ya migrada;
// las transiciones pasan por la API real y el contrato OpenAPI, y el worker por sus casos de uso.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { assertContract } from '../test/support/openapi.ts'
import { createApi } from '../dist/composition.js'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createLotExpiryRepository } from '../dist/infrastructure/postgres/expiry-repository.js'
import { createExpiryUseCases } from '../dist/application/expiries/use-cases.js'
import { createReservationRepository } from '../dist/infrastructure/postgres/reservation-repository.js'
import { createOutboxRepository } from '../dist/infrastructure/postgres/notification-repository.js'
import { createOutboxProcessor } from '../dist/application/notifications/use-cases.js'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_k030_test_/.test(new URL(connectionString).pathname.slice(1)),
  'Se requiere base de prueba aislada K030')
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
    const result = response.status === 204 ? undefined : await response.json()
    if (result?.csrfToken) csrf = result.csrfToken
    assertContract(method, path, response, result)
    if (response.status === 429 && retry < 3) {
      await new Promise(resolve => setTimeout(resolve, Number(response.headers.get('retry-after')) * 1000))
      return call(method, path, body, retry + 1)
    }
    return { status: response.status, body: result }
  }
}
const password = 'Clave-ficticia-K030-segura'
async function person(label) {
  const call = client()
  await call('GET', '/auth/session')
  const email = `k030-${label}-${randomUUID()}@example.invalid`
  assert.equal((await call('POST', '/auth/register', { email, password, privacyConsent: true })).status, 201)
  assert.equal((await call('POST', '/auth/login', { email, password })).status, 200)
  const { rows } = await database.query('SELECT id::text FROM users WHERE email = $1', [email])
  return { call, email, userId: rows[0].id }
}

const pool = createPool({ connectionString })
// Mismo caso de uso que el trabajador de vencimientos (K028): registra la oferta vencida bajo el bloqueo.
const expiries = createExpiryUseCases(createLotExpiryRepository(pool), () => {})
const outboxRepository = createOutboxRepository(pool)
const worker = (now = () => new Date()) => createOutboxProcessor(outboxRepository, now, () => 0.5)
/** Corre el worker hasta vaciar lo disponible; devuelve cuántos eventos tomó. */
async function drain(processor = worker()) {
  let total = 0
  for (let taken = await processor.processNext(); taken > 0; taken = await processor.processNext()) total += taken
  return total
}
const events = async (where = 'TRUE', params = []) =>
  (await database.query(`SELECT event_type, status, recipient_user_id::text AS recipient, payload FROM outbox_events
    WHERE ${where} ORDER BY id`, params)).rows
const notificationCount = async userId =>
  (await database.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1', [userId])).rows[0].n
const inbox = async who => (await who.call('GET', '/notifications')).body

try {
  await database.connect()
  const establishment = (await database.query(`INSERT INTO establishments
    (name, address, latitude, longitude, time_zone) VALUES ('K030 Avisos', 'Santiago', -33.45, -70.66, 'America/Santiago')
    RETURNING id`)).rows[0].id
  const makeLot = async (quantity, description = 'Pan del día K030') =>
    (await database.query(`INSERT INTO lots (establishment_id, description, category, quantity, address, latitude,
       longitude, time_zone, pickup_starts_at, pickup_ends_at, status, published_at)
     VALUES ($1, $2, 'Panadería', $3, 'Santiago Centro', -33.45, -70.66, 'America/Santiago',
       now() - interval '1 hour', now() + interval '2 hours', 'published', now() - interval '2 hours')
     RETURNING public_id::text AS id`, [establishment, description, quantity])).rows[0].id

  const ana = await person('ana')
  const bea = await person('bea')
  const cata = await person('cata')

  // --- Cancelar libera y ofrece en la misma transacción: dos eventos, cada uno a su titular.
  const lot = await makeLot(2)
  const reserved = await ana.call('POST', `/public/lots/${lot}/reservations`, { quantity: 2, idempotencyKey: randomUUID() })
  assert.equal(reserved.status, 201)
  const joined = await bea.call('POST', `/public/lots/${lot}/waitlist`, { quantity: 1, idempotencyKey: randomUUID() })
  assert.equal(joined.body.status, 'waiting')
  assert.deepEqual(await events(), [], 'reservar directamente y esperar no generan avisos en K030')
  assert.equal((await ana.call('POST', `/reservations/${reserved.body.id}/cancel`, {})).status, 200)
  const pending = await events()
  assert.deepEqual(pending.map(row => [row.event_type, row.status, row.recipient]),
    [['reservation_cancelled', 'pending', ana.userId], ['offer_issued', 'pending', bea.userId]])
  assert.equal(pending[1].payload.waitlistEntryId, joined.body.id)
  assert.ok(!JSON.stringify(pending).match(/[0-9A-HJKMNP-TV-Z]{8}"/), 'el payload no lleva códigos de retiro')
  assert.equal((await inbox(bea)).items.length, 0, 'sin worker aún no hay aviso, pero el evento ya está confirmado')
  ok('cancelar confirma su evento y el de la oferta emitida junto con la transición')

  // --- Una transición revertida no deja evento (misma transacción).
  const rollbackLot = await makeLot(1, 'Lote de rollback K030')
  const rollbackReservation = await cata.call('POST', `/public/lots/${rollbackLot}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })
  const reservations = createReservationRepository(pool)
  await assert.rejects(reservations.withHolderTransaction(cata.userId, rollbackReservation.body.id, async (state, writer) => {
    await writer.cancel(state.now)
    throw new Error('falla posterior a cancelar')
  }), /falla posterior/)
  assert.equal((await events('event_type = $1 AND recipient_user_id = $2', ['reservation_cancelled', cata.userId])).length, 0)
  assert.equal((await cata.call('GET', `/reservations/${rollbackReservation.body.id}`)).body.status, 'confirmed')
  ok('si la transición se revierte, su evento también: no hay aviso de algo que no ocurrió')

  // --- El worker genera exactamente un aviso por evento y destinatario.
  assert.equal(await drain(), 2)
  const beaInbox = await inbox(bea)
  assert.equal(beaInbox.unreadCount, 1)
  assert.equal(beaInbox.items[0].kind, 'offer_issued')
  assert.equal(beaInbox.items[0].waitlistEntryId, joined.body.id)
  assert.equal(beaInbox.items[0].quantity, 1)
  assert.ok(Date.parse(beaInbox.items[0].offerExpiresAt) > Date.now())
  assert.equal(beaInbox.items[0].lot.description, 'Pan del día K030')
  const anaInbox = await inbox(ana)
  assert.deepEqual(anaInbox.items.map(item => [item.kind, item.reservationId]), [['reservation_cancelled', reserved.body.id]])
  ok('el worker genera un aviso por destinatario: oferta para Bea, cancelación para Ana')

  // --- Reprocesar un evento ya entregado (caída tras generar, antes de marcar) no duplica.
  await database.query(`UPDATE outbox_events SET status = 'pending', processed_at = NULL`)
  assert.equal(await drain(), 2)
  assert.equal(await notificationCount(bea.userId), 1)
  assert.equal(await notificationCount(ana.userId), 1)
  ok('un evento reprocesado no duplica avisos (unicidad por evento y destinatario)')

  // --- Aceptar la oferta crea la reserva y su aviso, sin código.
  const accepted = await bea.call('POST', `/waitlist/${joined.body.id}/accept`, {})
  assert.equal(accepted.status, 200)
  await drain()
  const afterAccept = await inbox(bea)
  assert.deepEqual(afterAccept.items.map(item => item.kind), ['reservation_confirmed', 'offer_issued'])
  assert.equal(afterAccept.items[0].reservationId, accepted.body.reservationId)
  assert.ok(!JSON.stringify(afterAccept).includes('pickupCode'))
  ok('aceptar la oferta avisa la reserva confirmada con enlace a su detalle y sin código')

  // --- Permisos: cada persona ve y lee solo sus avisos.
  const beaNotice = afterAccept.items[1].id
  assert.equal((await ana.call('POST', `/notifications/${beaNotice}/read`, {})).status, 404)
  assert.equal((await ana.call('POST', `/notifications/${randomUUID()}/read`, {})).status, 404)
  assert.ok((await inbox(ana)).items.every(item => item.kind === 'reservation_cancelled'))
  ok('un aviso ajeno responde igual que uno inexistente (404) y no aparece en otra bandeja')

  // --- Vencimiento de una oferta: aviso, lectura y ninguna reactivación.
  // Solo se espera si no se puede reservar directamente (K027): Ana toma el pack y luego lo libera.
  const expiringLot = await makeLot(1, 'Pasteles K030')
  const blocker = await ana.call('POST', `/public/lots/${expiringLot}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })
  const offered = await cata.call('POST', `/public/lots/${expiringLot}/waitlist`, { quantity: 1, idempotencyKey: randomUUID() })
  assert.equal(offered.body.status, 'waiting')
  assert.equal((await ana.call('POST', `/reservations/${blocker.body.id}/cancel`, {})).status, 200)
  assert.equal((await cata.call('GET', `/waitlist/${offered.body.id}`)).body.status, 'offered')
  await database.query(`UPDATE waitlist_entries SET offered_at = now() - interval '20 minutes',
    offer_expires_at = now() - interval '10 minutes' WHERE public_id = $1`, [offered.body.id])
  assert.ok((await expiries.expireLot(expiringLot)).closedEntries >= 1)
  await drain()
  const cataInbox = await inbox(cata)
  const expiredNotice = cataInbox.items.find(item => item.kind === 'offer_expired')
  assert.ok(expiredNotice && cataInbox.items.some(item => item.kind === 'offer_issued'))
  const read = await cata.call('POST', `/notifications/${expiredNotice.id}/read`, {})
  assert.equal(read.status, 200)
  const again = await cata.call('POST', `/notifications/${expiredNotice.id}/read`, {})
  assert.equal(again.body.readAt, read.body.readAt, 'la primera lectura se conserva')
  const offerNotice = cataInbox.items.find(item => item.kind === 'offer_issued')
  assert.equal((await cata.call('POST', `/notifications/${offerNotice.id}/read`, {})).status, 200)
  assert.equal((await cata.call('GET', `/waitlist/${offered.body.id}`)).body.status, 'expired')
  assert.notEqual((await cata.call('POST', `/waitlist/${offered.body.id}/accept`, {})).status, 200)
  assert.equal((await database.query('SELECT status FROM waitlist_entries WHERE public_id = $1', [offered.body.id])).rows[0].status, 'expired')
  ok('una oferta vencida avisa; leer sus avisos no la reactiva ni permite aceptarla')

  // --- Desconectado: el aviso persiste y se recupera al volver a iniciar sesión.
  assert.equal((await bea.call('POST', '/auth/logout')).status, 204)
  const reconnect = client()
  await reconnect('GET', '/auth/session')
  assert.equal((await reconnect('POST', '/auth/login', { email: bea.email, password })).status, 200)
  const recovered = (await reconnect('GET', '/notifications')).body
  assert.deepEqual(recovered.items.map(item => item.kind), ['reservation_confirmed', 'offer_issued'])
  assert.equal(recovered.unreadCount, 2)
  ok('el aviso existe tras cerrar sesión y volver: generar y leer son estados distintos')

  // --- Caída a mitad de una tanda: el reclamo vence y otro ciclo la retoma sin omitir ni duplicar.
  await database.query('DELETE FROM notifications'); await database.query('DELETE FROM outbox_events')
  const insertEvents = async (count, userId) => database.query(
    `INSERT INTO outbox_events (event_type, subject_id, recipient_user_id, payload, created_at, available_at)
     SELECT 'offer_issued', 1000000 + g, $2, $3::jsonb, now(), now() FROM generate_series(1, $1) AS g`,
    [count, userId, JSON.stringify({ lot: { id: lot, description: 'Carga K030' }, quantity: 1,
      waitlistEntryId: randomUUID(), reservationId: null, offerExpiresAt: null })])
  await insertEvents(60, cata.userId)
  const claimed = await outboxRepository.claim(50, new Date(), new Date(Date.now() + 120_000))
  assert.equal(claimed.length, 50, 'una tanda reclama hasta 50 eventos')
  // El proceso cae sin entregar: los 50 quedan reclamados y otro ciclo solo ve los 10 restantes.
  assert.equal(await worker().processNext(), 10)
  assert.equal(await notificationCount(cata.userId), 10)
  // Al vencer el reclamo, otro ciclo retoma la tanda.
  assert.equal(await drain(worker(() => new Date(Date.now() + 121_000))), 50)
  assert.equal(await notificationCount(cata.userId), 60)
  assert.deepEqual((await events()).map(row => row.status).filter(status => status !== 'processed'), [])
  ok('un reclamo vencido se retoma: 60 eventos, 60 avisos, ninguno omitido ni duplicado')

  // --- Dos workers a la vez no toman el mismo evento.
  await database.query('DELETE FROM notifications'); await database.query('DELETE FROM outbox_events')
  await insertEvents(100, ana.userId)
  const started = Date.now()
  const taken = await Promise.all([drain(), drain()])
  const elapsed = Date.now() - started
  assert.equal(taken[0] + taken[1], 100)
  assert.equal(await notificationCount(ana.userId), 100)
  assert.ok(elapsed < 30_000, `100 avisos en ${elapsed} ms`)
  ok(`dos workers en paralelo: 100 eventos, 100 avisos sin duplicar (${elapsed} ms; meta E1 ≤ 30 s)`)

  // --- Un evento que agota sus intentos tras caídas queda visible como fallido.
  await database.query('DELETE FROM notifications'); await database.query('DELETE FROM outbox_events')
  await insertEvents(1, ana.userId)
  await database.query(`UPDATE outbox_events SET attempts = 5, claimed_until = now() - interval '1 second'`)
  assert.equal(await worker().processNext(), 0)
  assert.deepEqual((await events()).map(row => row.status), ['failed'])
  ok('tras agotar los intentos el evento queda failed, visible para revisión')

  console.log(`PASS K030: ${checks} grupos de integración con PostgreSQL real`)
} finally {
  server.close()
  await api.close()
  await pool.end()
  await database.end()
}
