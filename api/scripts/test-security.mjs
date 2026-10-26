// K034: aislamiento entre personas y operadores, límites de códigos, sesión y registros sin
// secretos contra PostgreSQL real. La API corre en un proceso hijo (test-security-server.mjs)
// para reiniciarla y leer todo lo que registra. Usa una base aislada y ya migrada.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { assertContract } from '../test/support/openapi.ts'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createOutboxRepository } from '../dist/infrastructure/postgres/notification-repository.js'
import { createOutboxProcessor } from '../dist/application/notifications/use-cases.js'

const connectionString = process.env.DATABASE_URL
let databaseUrl = null
try { databaseUrl = new URL(connectionString) } catch { databaseUrl = null }
const databaseName = databaseUrl?.pathname.slice(1) ?? ''
assert.ok(/^rescate_k034_test_/.test(databaseName), 'Se requiere base de prueba aislada K034')

const ORIGIN = 'https://localhost:5173'
const SESSION = '__Host-rescate_session'
const CSRF = '__Host-rescate_csrf'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let checks = 0
const ok = label => console.log(`OK ${++checks}: ${label}`)

// --- Registros: valores que ninguna salida de la API puede contener, con etiqueta para no repetirlos.
const secrets = new Map()
const secret = (label, value) => { if (value) secrets.set(value, label) }
const addCode = code => { secret('código de retiro', code); secret('código de retiro', code.toLowerCase()) }
const csrfKey = randomBytes(32).toString('base64')
const pickupKey = randomBytes(32).toString('base64')
secret('CSRF_SIGNING_KEY', csrfKey)
secret('PICKUP_CODE_KEY', pickupKey)
secret('contraseña de DATABASE_URL', databaseUrl.password)
secret('contraseña de DATABASE_URL', decodeURIComponent(databaseUrl.password))

// --- API en proceso hijo: mismo entorno en cada arranque; stdout y stderr de todas las instancias.
const directory = await mkdtemp(join(tmpdir(), 'rescate-k034-'))
const { NODE_ENV: _environment, ...inherited } = process.env
const apiEnvironment = { ...inherited, RESCATE_ALLOWED_ORIGINS: ORIGIN, CSRF_SIGNING_KEY: csrfKey,
  PICKUP_CODE_KEY: pickupKey, PHOTO_STORAGE: 'local', PHOTO_LOCAL_DIR: directory }
const serverScript = fileURLToPath(new URL('./test-security-server.mjs', import.meta.url))
let logs = ''
let api = null
let base = ''
let instances = 0
async function startApi() {
  instances++
  const child = fork(serverScript, [], { env: apiEnvironment, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  // 'close' llega después de vaciar stdout y stderr: ninguna línea queda fuera de la revisión.
  api = { child, exit: once(child, 'close') }
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', chunk => { logs += chunk })
  }
  const timeout = new Promise(resolve => setTimeout(resolve, 15_000).unref())
  const message = await Promise.race([once(child, 'message').then(([value]) => value), api.exit.then(() => null), timeout])
  assert.ok(Number.isInteger(message?.port), 'La API debe iniciar e informar su puerto por IPC')
  base = `http://127.0.0.1:${message.port}`
}
async function stopApi() {
  const { child, exit } = api
  api = null
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  const [code, signal] = await exit
  clearTimeout(timer)
  assert.deepEqual({ code, signal }, { code: 0, signal: null }, 'SIGTERM debe cerrar servidor y pool con código 0')
}
async function restartApi() {
  await stopApi()
  await startApi()
}

// --- Cliente HTTP. Ritmo propio bajo los límites generales (3000/min por IP con ráfaga 100;
// 120/min por usuario con ráfaga 20, el más estricto de escrituras y lecturas) para que un 429 sea siempre el límite que se prueba.
function pacer(perSecond, burst) {
  let tokens = burst
  let at = performance.now()
  let turn = Promise.resolve()
  const refill = () => {
    const time = performance.now()
    tokens = Math.min(burst, tokens + (time - at) * perSecond / 1000)
    at = time
  }
  return () => (turn = turn.then(async () => {
    refill()
    if (tokens < 1) { await sleep(Math.ceil((1 - tokens) * 1000 / perSecond)); refill() }
    tokens -= 1
  }))
}
const ipPace = pacer(40, 80)
let audited = 0
/** Una solicitud sin estado: valida contrato y cabeceras, y anota cookies, tokens y códigos emitidos. */
async function send(method, path, { headers = {}, body } = {}) {
  await ipPace()
  const response = await fetch(`${base}${path}`, { method, headers, body })
  assert.equal(response.headers.get('x-powered-by'), null, `${method} ${path} no debe anunciar el framework`)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${method} ${path} debe llevar nosniff`)
  audited++
  const cookies = response.headers.getSetCookie().map(line => {
    const [pair] = line.split(';'); const at = pair.indexOf('=')
    return [pair.slice(0, at), pair.slice(at + 1)]
  })
  for (const [name, value] of cookies) secret(`cookie ${name}`, value)
  const json = (response.headers.get('content-type') ?? '').includes('application/json')
  const result = json ? await response.json() : (await response.arrayBuffer(), undefined)
  if (typeof result?.csrfToken === 'string') secret('token CSRF', result.csrfToken)
  if (typeof result?.pickupCode === 'string') addCode(result.pickupCode)
  if (path !== '/health') assertContract(method, path, response, result)
  return { status: response.status, body: result, headers: response.headers, cookies }
}
const cookieHeader = jar => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
// En revisar y confirmar códigos un 429 siempre es un resultado a comprobar: no se reintenta.
const codeRoute = /^\/lots\/[^/]+\/(pickup-reviews|pickups)$/
let retries = 0
/** Sesión propia, como otro navegador: cookies, token CSRF y ritmo por usuario separados. */
function client() {
  const who = { jar: new Map(), csrf: '' }
  const pace = pacer(1.6, 16)
  who.call = async (method, path, body, { strict = codeRoute.test(path), headers = {}, bytes } = {}) => {
    for (let attempt = 0; ; attempt++) {
      if (who.jar.has(SESSION)) await pace()
      const result = await send(method, path, {
        body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)),
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(who.jar.size ? { cookie: cookieHeader(who.jar) } : {}),
          ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': who.csrf }), ...headers },
      })
      for (const [name, value] of result.cookies) {
        if (value) who.jar.set(name, value)
        else who.jar.delete(name)
      }
      if (typeof result.body?.csrfToken === 'string') who.csrf = result.body.csrfToken
      // Preparación: solo se espera un límite general (Retry-After ≤ 2 s); nunca uno mayor.
      const wait = Number(result.headers.get('retry-after'))
      if (result.status !== 429 || strict || !(wait >= 1 && wait <= 2) || attempt === 3) return result
      retries++
      await sleep(wait * 1000)
    }
  }
  return who
}

const database = new pg.Client({ connectionString })
const pool = createPool({ connectionString })
const query = async (text, params) => (await database.query(text, params)).rows
const row = async (table, publicId) =>
  (await query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE public_id = $1`, [publicId]))[0]?.value
/** Ejecuta rechazos y comprueba que no cambiaron nada de lo que `read` observa en la base. */
async function unchanged(read, action) {
  const before = await read()
  await action()
  assert.deepEqual(await read(), before)
}
const count = async (text, params) => (await query(`SELECT count(*)::int AS n ${text}`, params))[0].n
const failures = who => count('FROM pickup_code_failures WHERE user_id = $1', [who.userId])
const blockOf = async who => (await query(
  'SELECT blocked_until::text AS until FROM pickup_code_security_state WHERE user_id = $1', [who.userId]))[0]?.until ?? null
const deliveriesOf = reservationId => count(`FROM deliveries d JOIN commitments c ON c.id = d.commitment_id
  WHERE c.public_id = $1`, [reservationId])

async function person(label) {
  const who = client()
  const email = `k034-${label}-${randomUUID()}@example.invalid`
  const password = `Clave-K034-${randomBytes(9).toString('base64url')}`
  secret('correo', email)
  secret('contraseña', password)
  await who.call('GET', '/auth/session')
  assert.equal((await who.call('POST', '/auth/register', { email, password, privacyConsent: true })).status, 201)
  assert.equal((await who.call('POST', '/auth/login', { email, password })).status, 200)
  const [{ id }] = await query('SELECT id::text FROM users WHERE email = $1', [email])
  return Object.assign(who, { label, email, password, userId: id })
}
// Alfabeto de los códigos emitidos; un código aleatorio no coincide con ninguna reserva.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function wrongCode() {
  const code = Array.from(randomBytes(8), byte => ALPHABET[byte % 32]).join('')
  addCode(code)
  return code
}
const review = (who, lot, code, options) => who.call('POST', `/lots/${lot}/pickup-reviews`, { code }, options)
const confirm = (who, lot, reservationId, code) =>
  who.call('POST', `/lots/${lot}/pickups`, { reservationId, code, idempotencyKey: randomUUID() })
function rateLimited(response, maximum) {
  assert.deepEqual([response.status, response.body.error.code], [429, 'RATE_LIMITED'])
  const wait = Number(response.headers.get('retry-after'))
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= maximum, `Retry-After ${wait} fuera de 1..${maximum}`)
  return wait
}

try {
  await database.connect()
  await startApi()
  const establishment = async name => (await query(`INSERT INTO establishments
    (name, address, latitude, longitude, time_zone) VALUES ($1, 'Santiago', -33.45, -70.66, 'America/Santiago')
    RETURNING id::text, public_id::text`, [name]))[0]
  const placeA = await establishment('K034 Local A')
  const placeB = await establishment('K034 Local B')
  // Publicado, con la ventana de retiro ya abierta y cierre en dos horas.
  const makeLot = async quantity => (await query(`INSERT INTO lots (establishment_id, description, category, quantity,
      address, latitude, longitude, time_zone, pickup_starts_at, pickup_ends_at, status, published_at)
    VALUES ($1, 'Pack K034', 'Panadería', $2, 'Santiago Centro', -33.45, -70.66, 'America/Santiago',
      now() - interval '1 hour', now() + interval '2 hours', 'published', now() - interval '2 hours')
    RETURNING public_id::text AS id`, [placeA.id, quantity]))[0].id
  const member = (who, place) => query('INSERT INTO memberships (user_id, establishment_id) VALUES ($1, $2)', [who.userId, place.id])

  // Todos los inicios de sesión ocurren aquí: el límite de 30 por IP es de la instancia en memoria.
  const holder = await person('titular')
  const stranger = await person('ajeno')
  const rival = await person('rival')
  const leaver = await person('sale')
  const operatorA = await person('operador-a')
  const operatorA2 = await person('operador-a2')
  const operatorB = await person('operador-b')
  const operatorC = await person('operador-c')
  const operatorD = await person('operador-d')
  const operatorE = await person('operador-e')
  for (const who of [operatorA, operatorA2, operatorC, operatorD, operatorE]) await member(who, placeA)
  await member(operatorB, placeB)

  async function reserve(who, lot) {
    const created = await who.call('POST', `/public/lots/${lot}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })
    assert.equal(created.status, 201)
    const detail = await who.call('GET', `/reservations/${created.body.id}`)
    assert.equal(detail.body.status, 'confirmed')
    return { id: created.body.id, code: detail.body.pickupCode }
  }
  const lotA = await makeLot(5)
  const otherLotA = await makeLot(5)
  const reservation = await reserve(holder, lotA)
  const otherReservation = await reserve(holder, otherLotA)

  // === A. Accesos cruzados por HTTP real.
  await unchanged(async () => [await row('commitments', reservation.id), await row('lots', lotA)], async () => {
    assert.equal((await stranger.call('GET', `/reservations/${reservation.id}`)).status, 404)
    assert.equal((await stranger.call('POST', `/reservations/${reservation.id}/cancel`, {})).status, 404)
    const listed = await stranger.call('GET', '/reservations')
    assert.equal(listed.status, 200)
    assert.ok(!listed.body.items.some(item => item.id === reservation.id))
  })
  assert.equal((await row('commitments', reservation.id)).status, 'confirmed')
  ok('reserva ajena: consultar y cancelar 404, el listado no la incluye; sigue confirmada')

  const queueLot = await makeLot(1)
  const rivalReservation = await rival.call('POST', `/public/lots/${queueLot}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })
  assert.equal(rivalReservation.status, 201)
  const joined = await holder.call('POST', `/public/lots/${queueLot}/waitlist`, { quantity: 1, idempotencyKey: randomUUID() })
  assert.deepEqual([joined.status, joined.body.status], [201, 'waiting'])
  assert.equal((await rival.call('POST', `/reservations/${rivalReservation.body.id}/cancel`, {})).status, 200)
  const entry = joined.body.id
  assert.equal((await row('waitlist_entries', entry)).status, 'offered')
  const queueState = async () => [await row('waitlist_entries', entry), await row('lots', queueLot),
    await count('FROM commitments c JOIN lots l ON l.id = c.lot_id WHERE l.public_id = $1', [queueLot])]
  await unchanged(queueState, async () => {
    assert.equal((await stranger.call('GET', `/waitlist/${entry}`)).status, 404)
    for (const command of ['accept', 'decline', 'leave']) {
      assert.equal((await stranger.call('POST', `/waitlist/${entry}/${command}`, {})).status, 404)
    }
    assert.ok(!(await stranger.call('GET', '/waitlist')).body.items.some(item => item.id === entry))
  })
  assert.equal((await row('waitlist_entries', entry)).status, 'offered')
  const accepted = await holder.call('POST', `/waitlist/${entry}/accept`, {})
  assert.deepEqual([accepted.status, accepted.body.status], [200, 'accepted'])
  assert.equal((await holder.call('GET', `/reservations/${accepted.body.reservationId}`)).status, 200)
  ok('oferta ajena: consultar, aceptar, rechazar y salir 404 sin compromiso ni contadores nuevos; su titular la acepta')

  // Mismo procesador que el worker (K030), dentro de la suite y hasta vaciar el outbox.
  const outbox = createOutboxProcessor(createOutboxRepository(pool), () => new Date(), Math.random,
    event => { logs += `${JSON.stringify(event)}\n` })
  while (await outbox.processNext() > 0) { /* siguiente tanda */ }
  const holderNotices = (await holder.call('GET', '/notifications')).body.items.map(item => item.id)
  assert.ok(holderNotices.length > 0, 'el titular debe tener avisos')
  const notice = holderNotices[0]
  await unchanged(() => row('notifications', notice), async () => {
    const inbox = await stranger.call('GET', '/notifications')
    assert.equal(inbox.status, 200)
    assert.ok(!inbox.body.items.some(item => holderNotices.includes(item.id)))
    assert.equal((await stranger.call('POST', `/notifications/${notice}/read`, {})).status, 404)
  })
  assert.equal((await row('notifications', notice)).read_at, null)
  ok(`avisos ajenos (${holderNotices.length} del titular): no aparecen en otra bandeja y marcarlos leídos es 404; read_at sigue null`)

  const draftBody = () => ({ description: 'Borrador K034', category: 'Panadería', quantity: 3, conditions: null,
    address: 'Santiago Centro', latitude: -33.45, longitude: -70.66, timeZone: 'America/Santiago',
    pickupStartsAt: new Date(Date.now() + 3_600_000).toISOString(),
    pickupEndsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() })
  const createDraft = async () => {
    const created = await operatorA.call('POST', `/establishments/${placeA.public_id}/lots`, draftBody())
    assert.deepEqual([created.status, created.body.status], [201, 'draft'])
    return created.body.id
  }
  const draft = await createDraft()
  const otherDraft = await createDraft()
  const lotsOfA = () => query('SELECT to_jsonb(l) AS value FROM lots l WHERE establishment_id = $1 ORDER BY id', [placeA.id])
  await unchanged(lotsOfA, async () => {
    for (const who of [operatorB, holder, stranger]) {
      for (const lot of [lotA, draft]) {
        const { version } = await row('lots', lot)
        assert.equal((await who.call('GET', `/lots/${lot}`)).status, 403)
        assert.equal((await who.call('PATCH', `/lots/${lot}`, { version, description: 'Cambio ajeno K034' })).status, 403)
        assert.equal((await who.call('POST', `/lots/${lot}/publish`, { version })).status, 403)
      }
      assert.equal((await who.call('GET', `/establishments/${placeA.public_id}/lots`)).status, 403)
      assert.equal((await who.call('POST', `/establishments/${placeA.public_id}/lots`, draftBody())).status, 403)
    }
  })
  ok('lotes de A (publicado y borrador): operador de B, titular y ajeno reciben 403 al leer, editar, publicar, listar y crear; sin cambios')

  // Firma PNG: la API solo revisa la firma; decodificar corresponde al worker.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(24)])
  const upload = (who, lot) => who.call('POST', `/lots/${lot}/photos`, undefined,
    { bytes: png, headers: { 'content-type': 'image/png' } })
  const uploaded = await upload(operatorA, draft)
  assert.equal(uploaded.status, 202)
  const photo = uploaded.body.id
  await unchanged(async () => [await row('lot_photos', photo), await count('FROM lot_photos')], async () => {
    assert.equal((await upload(operatorB, draft)).status, 403)
    assert.equal((await operatorB.call('GET', `/lots/${draft}/photos`)).status, 403)
    assert.equal((await operatorB.call('DELETE', `/lots/${draft}/photos/${photo}`)).status, 403)
    assert.equal((await operatorB.call('GET', `/lots/${draft}/photos/${photo}/thumbnail`)).status, 404)
    assert.equal((await operatorA.call('DELETE', `/lots/${otherDraft}/photos/${photo}`)).status, 404)
  })
  ok('fotos: el operador de B no sube, lista, quita ni lee (403/404); quitarla desde otro lote propio es 404')

  const draftState = async () => [await row('lots', draft),
    await count('FROM commitments c JOIN lots l ON l.id = c.lot_id WHERE l.public_id = $1', [draft]),
    await count('FROM waitlist_entries e JOIN lots l ON l.id = e.lot_id WHERE l.public_id = $1', [draft])]
  await unchanged(draftState, async () => {
    for (const who of [holder, stranger]) {
      assert.equal((await who.call('POST', `/public/lots/${draft}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })).status, 404)
      assert.equal((await who.call('POST', `/public/lots/${draft}/waitlist`, { quantity: 1, idempotencyKey: randomUUID() })).status, 404)
    }
  })
  ok('descubrimiento: reservar o esperar un lote en borrador es 404')

  const outsiders = [operatorB.userId, holder.userId]
  const pickupState = async () => [await row('commitments', reservation.id), await row('commitments', otherReservation.id),
    await row('lots', lotA), await row('lots', otherLotA), await count('FROM deliveries'),
    await count('FROM pickup_code_security_state WHERE user_id = ANY($1::bigint[])', [outsiders]),
    await count('FROM pickup_code_failures WHERE user_id = ANY($1::bigint[])', [outsiders])]
  await unchanged(pickupState, async () => {
    for (const who of [operatorB, holder]) {
      assert.equal((await review(who, lotA, reservation.code)).status, 403)
      assert.equal((await confirm(who, lotA, reservation.id, reservation.code)).status, 403)
    }
  })
  ok('retiro: operador de B y titular con el código válido reciben 403 al revisar y confirmar; sin fallos ni entrega')

  const crossState = async () => [await row('commitments', reservation.id), await row('commitments', otherReservation.id),
    await count('FROM deliveries')]
  await unchanged(crossState, async () => {
    const crossed = await confirm(operatorA2, lotA, otherReservation.id, otherReservation.code)
    assert.deepEqual([crossed.status, crossed.body.error.code], [404, 'NOT_FOUND'])
  })
  assert.equal(await failures(operatorA2), 1)
  ok('confirmar en el lote A una reserva y código de otro lote de A: 404, sin entrega, un fallo para ese operador')

  // === B. Límite de códigos persistido por operador.
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal((await review(operatorC, lotA, wrongCode())).status, 404)
  }
  assert.deepEqual([await failures(operatorC), await blockOf(operatorC)], [4, null])
  assert.equal((await confirm(operatorC, lotA, reservation.id, wrongCode())).status, 404)
  assert.equal(await failures(operatorC), 5)
  const [{ remaining }] = await query(`SELECT extract(epoch FROM blocked_until - now())::float AS remaining
    FROM pickup_code_security_state WHERE user_id = $1`, [operatorC.userId])
  assert.ok(remaining > 890 && remaining <= 900, `blocked_until debe quedar a 15 min (${remaining} s)`)
  ok(`4 revisiones y 1 confirmación con códigos erróneos: 404, 5 fallos y suspensión hasta now() + ${Math.round(remaining)} s`)

  const blockedState = async () => [await failures(operatorC), await blockOf(operatorC),
    await row('commitments', reservation.id), await deliveriesOf(reservation.id)]
  await unchanged(blockedState, async () => {
    rateLimited(await review(operatorC, lotA, reservation.code), 900)
    rateLimited(await confirm(operatorC, lotA, reservation.id, reservation.code), 900)
  })
  assert.equal((await row('commitments', reservation.id)).status, 'confirmed')
  ok('suspendido: revisar y confirmar con el código correcto responden 429 RATE_LIMITED; sin entrega, fallos ni plazo nuevos')

  await restartApi()
  await unchanged(blockedState, async () => {
    rateLimited(await review(operatorC, lotA, reservation.code), 900)
  })
  ok('tras reiniciar la API la suspensión sigue: 429 con el código correcto; filas y blocked_until intactos')

  const colleague = await review(operatorA, lotA, reservation.code)
  assert.deepEqual([colleague.status, colleague.body.reservation.id, colleague.body.canConfirm], [200, reservation.id, true])
  ok('otro operador del mismo local, sin fallos, revisa el mismo código: 200')

  const burst = await Promise.all(Array.from({ length: 10 }, () => review(operatorD, lotA, wrongCode())))
  assert.deepEqual(burst.map(result => result.status).sort(), [...Array(5).fill(404), ...Array(5).fill(429)])
  for (const result of burst.filter(item => item.status === 429)) rateLimited(result, 900)
  assert.equal(await failures(operatorD), 5)
  ok('10 revisiones erróneas simultáneas de un operador nuevo: exactamente 5×404, 5×429 y 5 fallos')

  await query(`UPDATE pickup_code_failures SET failed_at = failed_at - interval '16 minutes' WHERE user_id = $1`, [operatorC.userId])
  await query(`UPDATE pickup_code_security_state SET blocked_until = blocked_until - interval '16 minutes'
    WHERE user_id = $1`, [operatorC.userId])
  const released = await review(operatorC, lotA, reservation.code)
  assert.deepEqual([released.status, released.body.reservation.id], [200, reservation.id])
  ok('pasados 15 minutos (fallos y plazo movidos 16 min al pasado) revisar el código correcto vuelve a responder 200')

  // === C. Límite por IP en memoria: 30 revisiones por minuto, recién reiniciada la instancia.
  await restartApi()
  const reviewers = [operatorA, operatorC, operatorA2]
  // Un solo cliente pg: las lecturas van en serie.
  const failuresOf = async people => { const counts = []; for (const who of people) counts.push(await failures(who)); return counts }
  const failuresBefore = await failuresOf([...reviewers, operatorE])
  // Sin membership o con un lote inexistente no se compara ningún código: no gastan el cupo del origen.
  const missingLot = randomUUID()
  for (let i = 0; i < 15; i++) {
    assert.equal((await review(stranger, lotA, reservation.code)).status, 403)
    assert.equal((await review(operatorA2, missingLot, reservation.code)).status, 404)
  }
  const started = performance.now()
  for (let round = 0; round < 10; round++) {
    for (const who of reviewers) assert.equal((await review(who, lotA, reservation.code)).status, 200)
  }
  // Un operador sin solicitudes en esta instancia: el 429 solo puede venir del límite por IP.
  const wait = rateLimited(await review(operatorE, lotA, reservation.code), 60)
  assert.ok(performance.now() - started < 60_000, 'las 31 revisiones autorizadas deben caer en el mismo minuto')
  assert.deepEqual(await failuresOf([...reviewers, operatorE]), failuresBefore)
  assert.equal(await blockOf(operatorE), null)
  ok(`30 rechazos sin permiso o sin lote no gastan el origen; 30 revisiones autorizadas sí y la 31.ª da 429 con Retry-After ${wait} s`)

  // === D. Protección de sesión.
  const saved = new Map(leaver.jar)
  assert.equal((await leaver.call('POST', '/auth/logout')).status, 204)
  const reusedSession = await send('GET', '/auth/session', { headers: { cookie: cookieHeader(saved) } })
  assert.equal(reusedSession.body.session, null)
  assert.equal((await send('GET', '/reservations', { headers: { cookie: cookieHeader(saved) } })).status, 401)
  assert.deepEqual((await query(`SELECT count(*)::int AS total, count(revoked_at)::int AS revoked FROM sessions
    WHERE user_id = $1`, [leaver.userId]))[0], { total: 1, revoked: 1 })
  ok('cookie reutilizada después del logout: sin sesión, GET /reservations 401 y revoked_at registrado')

  const sessionOf = cookie => send('GET', '/auth/session', { headers: { cookie } })
  const holderCookie = `${SESSION}=${holder.jar.get(SESSION)}`
  assert.equal((await sessionOf(holderCookie)).body.session?.user.email, holder.email)
  assert.equal((await sessionOf(`${holderCookie}; ${SESSION}=${stranger.jar.get(SESSION)}`)).body.session, null)
  assert.equal((await sessionOf(`${holderCookie}; ${holderCookie}`)).body.session, null)
  ok('dos cookies de sesión en la misma cabecera, distintas o repetidas: sin sesión')

  const holderHeaders = (changes = {}) => {
    const headers = { 'content-type': 'application/json', cookie: cookieHeader(holder.jar), origin: ORIGIN,
      'x-csrf-token': holder.csrf, ...changes }
    for (const [name, value] of Object.entries(headers)) if (value === undefined) delete headers[name]
    return headers
  }
  const cancel = headers => send('POST', `/reservations/${reservation.id}/cancel`, { headers, body: '{}' })
  const forbidden = response => assert.deepEqual([response.status, response.body.error.code], [403, 'FORBIDDEN'])
  const otherCsrf = new Map(holder.jar).set(CSRF, stranger.jar.get(CSRF))
  await unchanged(() => row('commitments', reservation.id), async () => {
    forbidden(await cancel(holderHeaders({ origin: undefined })))
    forbidden(await cancel(holderHeaders({ origin: 'https://ajeno.example' })))
    forbidden(await cancel(holderHeaders({ 'x-csrf-token': undefined })))
    forbidden(await cancel(holderHeaders({ 'x-csrf-token': stranger.csrf })))
    forbidden(await cancel(holderHeaders({ cookie: cookieHeader(otherCsrf), 'x-csrf-token': stranger.csrf })))
  })
  assert.equal((await row('commitments', reservation.id)).status, 'confirmed')
  ok('cancelar sin Origin, con Origin ajeno, sin token CSRF o con el token de otra sesión: 403 y la reserva sigue confirmada')

  const sessionsOfHolder = () => query('SELECT to_jsonb(s) AS value FROM sessions s WHERE user_id = $1 ORDER BY id', [holder.userId])
  const anonymous = client()
  await anonymous.call('GET', '/auth/session')
  const login = (changes = {}) => {
    const headers = { 'content-type': 'application/json', cookie: cookieHeader(anonymous.jar), origin: ORIGIN,
      'x-csrf-token': anonymous.csrf, ...changes }
    for (const [name, value] of Object.entries(headers)) if (value === undefined) delete headers[name]
    return send('POST', '/auth/login', { body: JSON.stringify({ email: holder.email, password: holder.password }), headers })
  }
  const logout = changes => send('POST', '/auth/logout', { headers: holderHeaders({ 'content-type': undefined, ...changes }) })
  await unchanged(sessionsOfHolder, async () => {
    forbidden(await login({ origin: undefined }))
    forbidden(await login({ 'x-csrf-token': undefined }))
    forbidden(await login({ 'x-csrf-token': stranger.csrf }))
    forbidden(await logout({ origin: undefined }))
    forbidden(await logout({ 'x-csrf-token': undefined }))
    forbidden(await logout({ 'x-csrf-token': stranger.csrf }))
  })
  ok('login con credenciales correctas y logout sin Origin, sin token CSRF o con el de otra sesión: 403, sin sesión nueva ni revocada')

  assert.equal((await send('GET', '/health')).status, 200)
  ok(`${audited} respuestas de la API, incluidas /health, errores y 204: sin X-Powered-By y con X-Content-Type-Options: nosniff`)

  // Límite de login por IP: la instancia recién iniciada no ha recibido ningún login.
  await restartApi()
  const visitor = client()
  await visitor.call('GET', '/auth/session')
  const unknownLogin = index => {
    const email = `k034-inexistente-${randomUUID()}@example.invalid`
    const password = `Clave-K034-${randomBytes(9).toString('base64url')}`
    secret('correo', email)
    secret('contraseña', password)
    return visitor.call('POST', '/auth/login', { email, password },
      { strict: true, headers: { 'x-forwarded-for': `198.51.100.${index + 1}` } })
  }
  for (let index = 0; index < 30; index++) {
    const response = await unknownLogin(index)
    assert.deepEqual([response.status, response.body.error.code], [401, 'UNAUTHENTICATED'])
  }
  const loginWait = rateLimited(await unknownLogin(30), 900)
  ok(`30 logins con X-Forwarded-For distintos: 401; el 31.º, 429 con Retry-After ${loginWait} s (la IP es la del socket)`)

  // === E. Registros sin secretos. Un fallo real (lock_timeout del bloqueo por operador) deja un evento.
  await database.query('BEGIN')
  try {
    await database.query('SELECT 1 FROM pickup_code_security_state WHERE user_id = $1 FOR UPDATE', [operatorA.userId])
    const timedOut = await review(operatorA, lotA, reservation.code)
    assert.deepEqual([timedOut.status, timedOut.body.error.code], [503, 'SERVICE_UNAVAILABLE'])
  } finally {
    await database.query('ROLLBACK')
  }
  await stopApi()
  // Ningún assert recibe `logs`: si fallara, imprimiría justo lo que la prueba debe mantener oculto.
  for (const [value, label] of secrets) assert.ok(!logs.includes(value), `Un registro contiene: ${label}`)
  for (const scheme of ['postgres://', 'postgresql://']) assert.ok(!logs.includes(scheme), `Un registro contiene ${scheme}`)
  assert.ok(logs.includes('request_failed') && logs.includes('55P03'), 'Falta el evento request_failed con código 55P03')
  ok(`registros sin secretos: ${Buffer.byteLength(logs)} bytes de ${instances} instancias revisados contra ${secrets.size} valores`)

  if (retries) console.log(`Reintentos de preparación por límites generales: ${retries}`)
  console.log(`PASS K034: ${checks} comprobaciones; base ${databaseName} conservada`)
} finally {
  if (api) {
    api.child.kill('SIGTERM')
    await api.exit
  }
  await database.query('ROLLBACK').catch(() => {})
  await database.end().catch(() => {})
  await pool.end().catch(() => {})
  await rm(directory, { recursive: true, force: true })
}
