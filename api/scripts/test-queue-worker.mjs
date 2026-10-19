// K031: flujo integrado de cola, vencimientos y avisos contra PostgreSQL real. Las personas
// usan la API real con sesiones separadas y el contrato OpenAPI; los vencimientos y avisos
// los registran procesos reales del worker, que se matan con kill -9 tras reclamar trabajo.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import pg from 'pg'
import { assertContract } from '../test/support/openapi.ts'
import { createApi } from '../dist/composition.js'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_k031_test_/.test(new URL(connectionString).pathname.slice(1)),
  'Se requiere base de prueba aislada K031')
const database = new pg.Client({ connectionString })
// Fuera de la transacción que retiene el bloqueo: pg_stat_activity se congela dentro de ella.
const observer = new pg.Client({ connectionString })
const api = createApi({ ...process.env, RESCATE_ALLOWED_ORIGINS: 'https://localhost:5173',
  CSRF_SIGNING_KEY: randomBytes(32).toString('base64'), PICKUP_CODE_KEY: randomBytes(32).toString('base64') })
const server = api.app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let checks = 0
const ok = label => console.log(`OK ${++checks}: ${label}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(label, condition, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await condition()) return; await sleep(50) }
  assert.fail(`Tiempo agotado: ${label}`)
}

/** Sesión propia, como otro navegador: cookies y CSRF separados. */
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
      await sleep(Number(response.headers.get('retry-after')) * 1000)
      return call(method, path, body, retry + 1)
    }
    return { status: response.status, body: result }
  }
}
async function person(label) {
  const call = client()
  await call('GET', '/auth/session')
  const email = `k031-${label}-${randomUUID()}@example.invalid`
  const password = 'Clave-ficticia-K031-segura'
  assert.equal((await call('POST', '/auth/register', { email, password, privacyConsent: true })).status, 201)
  assert.equal((await call('POST', '/auth/login', { email, password })).status, 200)
  const { rows } = await database.query('SELECT id::text FROM users WHERE email = $1', [email])
  return { label, call, userId: rows[0].id }
}
const kinds = async who => (await who.call('GET', '/notifications')).body.items.map(item => item.kind)

const workers = []
/** Proceso real del worker con vencimientos y avisos, sin almacenamiento de fotos. */
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
/** Espera a que un proceso del worker quede bloqueado en una sentencia que contiene `fragment`. */
const blockedOn = fragment => until(`worker bloqueado en ${fragment}`, async () => (await observer.query(
  `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
     AND query LIKE '%' || $1 || '%'`, [fragment])).rowCount > 0)

try {
  await database.connect()
  await observer.connect()
  const establishment = (await database.query(`INSERT INTO establishments
    (name, address, latitude, longitude, time_zone) VALUES ('K031 Panadería', 'Santiago', -33.45, -70.66, 'America/Santiago')
    RETURNING id`)).rows[0].id
  const lot = (await database.query(`INSERT INTO lots (establishment_id, description, category, quantity, address,
      latitude, longitude, time_zone, pickup_starts_at, pickup_ends_at, status, published_at)
    VALUES ($1, 'Pan del día K031', 'Panadería', 2, 'Santiago Centro', -33.45, -70.66, 'America/Santiago',
      now() - interval '1 hour', now() + interval '2 hours', 'published', now() - interval '2 hours')
    RETURNING public_id::text AS id`, [establishment])).rows[0].id

  const counters = async () => (await database.query(`SELECT free_quantity AS f, offered_quantity AS o,
      reserved_quantity AS r, delivered_quantity AS e, expired_quantity AS x FROM lots WHERE public_id = $1`, [lot])).rows[0]
  const entry = async id => (await database.query(`SELECT status, offered_quantity, offered_at, offer_expires_at, ended_at
    FROM waitlist_entries WHERE public_id = $1`, [id])).rows[0]
  const outbox = async () => (await database.query(`SELECT e.id::text, e.event_type, e.status, e.attempts,
      e.claimed_until, u.email, (SELECT count(*)::int FROM notifications n WHERE n.event_id = e.id) AS notices
    FROM outbox_events e JOIN users u ON u.id = e.recipient_user_id ORDER BY e.id`)).rows
  const trace = []
  /** Traza de cada paso: inventario, solicitudes, eventos y avisos. */
  async function step(label, entries) {
    const { f, o, r, e, x } = await counters()
    const states = await Promise.all(entries.map(async ([name, id]) => `${name}=${(await entry(id)).status}`))
    const events = await outbox()
    const line = `F=${f} O=${o} R=${r} E=${e} X=${x} | ${states.join(' ')} | eventos ${events.length}`
      + ` (${events.filter(row => row.status === 'pending').length} pendientes) | avisos ${events.reduce((n, row) => n + row.notices, 0)}`
    trace.push(`${label.padEnd(48)} ${line}`)
  }

  const ana = await person('ana')
  const bea = await person('bea')
  const cata = await person('cata')
  let worker = startWorker()

  // --- Ana reserva todo; Bea y Cata esperan en orden FIFO.
  const reservation = await ana.call('POST', `/public/lots/${lot}/reservations`, { quantity: 2, idempotencyKey: randomUUID() })
  assert.equal(reservation.status, 201)
  const beaEntry = await bea.call('POST', `/public/lots/${lot}/waitlist`, { quantity: 2, idempotencyKey: randomUUID() })
  const cataEntry = await cata.call('POST', `/public/lots/${lot}/waitlist`, { quantity: 2, idempotencyKey: randomUUID() })
  assert.deepEqual([beaEntry.status, beaEntry.body.status, beaEntry.body.position], [201, 'waiting', 1])
  assert.deepEqual([cataEntry.status, cataEntry.body.status, cataEntry.body.position], [201, 'waiting', 2])
  const entries = [['Bea', beaEntry.body.id], ['Cata', cataEntry.body.id]]
  await step('1. Ana reserva 2; Bea y Cata esperan', entries)
  assert.deepEqual(await counters(), { f: 0, o: 0, r: 2, e: 0, x: 0 })
  ok('Ana reserva los 2 packs; Bea queda primera y Cata segunda en la cola')

  // --- Cancelar libera y ofrece a la primera en la misma transacción; el worker avisa a cada sesión.
  assert.equal((await ana.call('POST', `/reservations/${reservation.body.id}/cancel`, {})).status, 200)
  assert.deepEqual(await counters(), { f: 0, o: 2, r: 0, e: 0, x: 0 })
  assert.equal((await bea.call('GET', `/waitlist/${beaEntry.body.id}`)).body.status, 'offered')
  const cataWaiting = (await cata.call('GET', `/waitlist/${cataEntry.body.id}`)).body
  assert.deepEqual([cataWaiting.status, cataWaiting.position], ['waiting', 1])
  await until('aviso de oferta en la sesión de Bea', async () => (await kinds(bea)).includes('offer_issued'))
  await until('aviso de cancelación en la sesión de Ana', async () => (await kinds(ana)).includes('reservation_cancelled'))
  assert.deepEqual(await kinds(cata), [], 'Cata no recibe nada mientras Bea tiene la oferta')
  await step('2. Ana cancela: oferta FIFO a Bea', entries)
  ok('cancelar libera R → F → O para Bea (FIFO); el worker avisa a Bea y a Ana en sus sesiones; Cata sigue esperando')

  // --- La oferta de Bea vence. El worker reclama el lote y muere a mitad del registro.
  assert.equal((await stopWorker(worker)).code, 0, 'SIGTERM termina el worker de forma ordenada')
  const { rows: [lapse] } = await database.query(`UPDATE waitlist_entries SET offered_at = offered_at - interval '1 hour',
    offer_expires_at = offer_expires_at - interval '1 hour' WHERE public_id = $1 RETURNING offer_expires_at`, [beaEntry.body.id])
  await database.query('BEGIN')
  await database.query('SELECT 1 FROM waitlist_entries WHERE public_id = $1 FOR UPDATE', [beaEntry.body.id])
  worker = startWorker()
  await blockedOn('waitlist_entries')
  assert.equal((await stopWorker(worker, 'SIGKILL')).signal, 'SIGKILL')
  await database.query('COMMIT')
  const { rows: [claimed] } = await database.query(`SELECT expiry_attempts AS attempts,
    expiry_claimed_until > now() AS leased FROM lots WHERE public_id = $1`, [lot])
  assert.deepEqual(claimed, { attempts: 1, leased: true }, 'el reclamo del worker muerto sigue vigente')
  assert.deepEqual([(await entry(beaEntry.body.id)).status, (await entry(cataEntry.body.id)).status], ['offered', 'waiting'])
  assert.deepEqual(await counters(), { f: 0, o: 2, r: 0, e: 0, x: 0 }, 'nada quedó a medias')
  // Sin registro, la API ya la informa vencida. Un comando sobre el lote la registraría:
  // aquí nadie actúa, para que lo haga el worker reiniciado.
  assert.equal((await bea.call('GET', `/waitlist/${beaEntry.body.id}`)).body.status, 'expired')
  await step('3. Oferta de Bea vence; worker muere (kill -9)', entries)
  ok('kill -9 tras reclamar el vencimiento: la transacción se revierte, el reclamo queda vigente y la API ya informa vencida la oferta')

  // --- El worker reiniciado retoma el lote al vencer la concesión. Esta vez muere tras
  // reclamar la tanda de avisos, antes de generarlos.
  await database.query('UPDATE lots SET expiry_claimed_until = now() WHERE public_id = $1', [lot])
  await database.query('BEGIN')
  await database.query('LOCK TABLE notifications IN SHARE MODE')
  worker = startWorker()
  await blockedOn('INSERT INTO public.notifications')
  assert.equal((await stopWorker(worker, 'SIGKILL')).signal, 'SIGKILL')
  await database.query('COMMIT')
  const expiredBea = await entry(beaEntry.body.id)
  const offeredCata = await entry(cataEntry.body.id)
  assert.deepEqual([expiredBea.status, expiredBea.ended_at], ['expired', lapse.offer_expires_at])
  assert.deepEqual([offeredCata.status, offeredCata.offered_quantity], ['offered', 2])
  assert.deepEqual(await counters(), { f: 0, o: 2, r: 0, e: 0, x: 0 })
  const { rows: [released] } = await database.query(`SELECT expiry_attempts AS attempts, expiry_claimed_until AS until
    FROM lots WHERE public_id = $1`, [lot])
  assert.deepEqual(released, { attempts: 0, until: null }, 'el worker completó el registro y soltó el lote')
  const stranded = (await outbox()).filter(row => row.status === 'pending')
  assert.deepEqual(stranded.map(row => [row.event_type, row.email.split('-')[1], row.attempts, row.notices]),
    [['offer_expired', 'bea', 1, 0], ['offer_issued', 'cata', 1, 0]])
  assert.ok(stranded.every(row => row.claimed_until > new Date()), 'la tanda quedó reclamada por el worker muerto')
  assert.equal((await cata.call('GET', `/waitlist/${cataEntry.body.id}`)).body.status, 'offered',
    'la oferta existe aunque su aviso aún no se genere')
  await step('4. Worker reiniciado registra; muere en avisos', entries)
  ok('el worker reiniciado registra el vencimiento a su hora y ofrece a Cata; muere tras reclamar los avisos sin generarlos')

  // --- Otro reinicio retoma la tanda al vencer su reclamo: un aviso por evento, sin repetir la oferta.
  await database.query(`UPDATE outbox_events SET claimed_until = now() WHERE status = 'pending'`)
  worker = startWorker()
  await until('aviso de oferta en la sesión de Cata', async () => (await kinds(cata)).includes('offer_issued'))
  await until('aviso de vencimiento en la sesión de Bea', async () => (await kinds(bea)).includes('offer_expired'))
  assert.deepEqual(await kinds(bea), ['offer_expired', 'offer_issued'])
  assert.deepEqual(await kinds(cata), ['offer_issued'])
  assert.deepEqual((await entry(cataEntry.body.id)).offered_at, offeredCata.offered_at, 'la oferta de Cata no se repite')
  assert.equal((await bea.call('POST', `/waitlist/${beaEntry.body.id}/accept`, {})).status, 409, 'una oferta vencida no se acepta')
  await step('5. Segundo reinicio genera los avisos', entries)
  ok('el segundo reinicio retoma la tanda: Bea ve su vencimiento y Cata su oferta, un aviso cada uno, sin repetir la oferta')

  // --- Cata acepta: nace su reserva con código y el aviso, sin código.
  const accepted = await cata.call('POST', `/waitlist/${cataEntry.body.id}/accept`, {})
  assert.equal(accepted.status, 200)
  const cataReservation = (await cata.call('GET', `/reservations/${accepted.body.reservationId}`)).body
  assert.deepEqual([cataReservation.status, cataReservation.quantity], ['confirmed', 2])
  assert.match(cataReservation.pickupCode, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  assert.deepEqual(await counters(), { f: 0, o: 0, r: 2, e: 0, x: 0 })
  await until('aviso de reserva en la sesión de Cata', async () => (await kinds(cata)).includes('reservation_confirmed'))
  assert.ok(!JSON.stringify((await cata.call('GET', '/notifications')).body).includes(cataReservation.pickupCode))
  await step('6. Cata acepta la oferta', entries)
  ok('Cata acepta: O → R, reserva con código de retiro y aviso de confirmación sin código')

  // --- El lote cierra: el mismo worker vence la reserva y todo pasa a X.
  const { rows: [{ ends }] } = await database.query(`UPDATE lots SET pickup_ends_at = date_trunc('second', now()) - interval '1 minute'
    WHERE public_id = $1 RETURNING pickup_ends_at AS ends`, [lot])
  await until('cierre del lote', async () => (await database.query('SELECT status FROM lots WHERE public_id = $1', [lot])).rows[0].status === 'expired')
  assert.deepEqual(await counters(), { f: 0, o: 0, r: 0, e: 0, x: 2 })
  const closed = (await cata.call('GET', `/reservations/${accepted.body.reservationId}`)).body
  assert.deepEqual([closed.status, closed.pickupCode, Date.parse(closed.endedAt)], ['expired', null, ends.getTime()])
  await step('7. El lote cierra', entries)
  assert.equal((await stopWorker(worker)).code, 0)
  ok('al cerrar el lote, el worker vence la reserva de Cata al instante del cierre y R → X')

  // --- Historial y conciliación del flujo completo.
  const history = (await database.query(`SELECT u.email, c.status FROM commitments c JOIN users u ON u.id = c.user_id
    JOIN lots l ON l.id = c.lot_id WHERE l.public_id = $1 ORDER BY c.id`, [lot])).rows
  assert.deepEqual(history.map(row => [row.email.split('-')[1], row.status]), [['ana', 'cancelled'], ['cata', 'expired']])
  const queue = (await database.query(`SELECT u.email, w.status, w.offered_quantity FROM waitlist_entries w
    JOIN users u ON u.id = w.user_id ORDER BY w.id`)).rows
  assert.deepEqual(queue.map(row => [row.email.split('-')[1], row.status]), [['bea', 'expired'], ['cata', 'accepted']])
  const events = await outbox()
  assert.deepEqual(events.map(row => [row.event_type, row.email.split('-')[1], row.status, row.notices]), [
    ['reservation_cancelled', 'ana', 'processed', 1], ['offer_issued', 'bea', 'processed', 1],
    ['offer_expired', 'bea', 'processed', 1], ['offer_issued', 'cata', 'processed', 1],
    ['reservation_confirmed', 'cata', 'processed', 1]])
  const { rows: [{ notices }] } = await database.query('SELECT count(*)::int AS notices FROM notifications')
  assert.equal(notices, events.length, 'un aviso por evento y destinatario, ninguno duplicado')
  const unreconciled = await database.query(`SELECT l.public_id FROM lots l
    WHERE l.quantity <> l.free_quantity + l.offered_quantity + l.reserved_quantity + l.delivered_quantity + l.expired_quantity
       OR l.reserved_quantity <> COALESCE((SELECT sum(c.quantity) FROM commitments c WHERE c.lot_id = l.id AND c.status = 'confirmed'), 0)
       OR l.offered_quantity <> COALESCE((SELECT sum(w.offered_quantity) FROM waitlist_entries w WHERE w.lot_id = l.id AND w.status = 'offered'), 0)`)
  assert.deepEqual(unreconciled.rows, [])
  for (const one of workers) assert.doesNotMatch(one.output, /postgresql:|worker_error/)
  ok('historial y conciliación: Ana cancelada, Bea vencida, Cata aceptada y vencida al cierre; Q = F + O + R + E + X; 5 eventos, 5 avisos')

  console.log('\nTraza del flujo:')
  for (const line of trace) console.log(`  ${line}`)
  console.log(`PASS K031: ${checks} grupos de integración con PostgreSQL real, API real y ${workers.length} procesos del worker`)
} finally {
  for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) await stopWorker(worker, 'SIGKILL')
  await database.query('ROLLBACK').catch(() => {})
  server.close()
  await api.close()
  await database.end().catch(() => {})
  await observer.end().catch(() => {})
}
