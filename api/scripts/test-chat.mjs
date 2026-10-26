// K037 · chat de la reserva contra PostgreSQL real. Usa una base aislada y ya migrada. Todo
// pasa por la API real y el contrato OpenAPI, y la retención por el mismo caso de uso del worker.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { assertContract } from '../test/support/openapi.ts'
import { createApi } from '../dist/composition.js'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createChatRepository } from '../dist/infrastructure/postgres/chat-repository.js'
import { createChatRetention } from '../dist/application/chat/use-cases.js'
import { createOutboxRepository } from '../dist/infrastructure/postgres/notification-repository.js'
import { createOutboxProcessor } from '../dist/application/notifications/use-cases.js'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_k037_test_/.test(new URL(connectionString).pathname.slice(1)),
  'Se requiere base de prueba aislada K037')
const database = new pg.Client({ connectionString })
const api = createApi({ ...process.env, RESCATE_ALLOWED_ORIGINS: 'https://localhost:5173',
  CSRF_SIGNING_KEY: randomBytes(32).toString('base64'), PICKUP_CODE_KEY: randomBytes(32).toString('base64') })
const server = api.app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let checks = 0
const ok = label => console.log(`OK ${++checks}: ${label}`)

/** Con `wait` un 429 espera Retry-After y reintenta. Sin él, el 429 se devuelve tal cual */
function client() {
  const cookies = new Map()
  let csrf = ''
  return async function call(method, path, body, { wait = true } = {}) {
    for (let attempt = 0; ; attempt++) {
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
      if (response.status !== 429 || !wait || attempt === 3) {
        return { status: response.status, body: result, retryAfter: response.headers.get('retry-after') }
      }
      await new Promise(resolve => setTimeout(resolve, Number(response.headers.get('retry-after')) * 1000))
    }
  }
}
const password = 'Clave-ficticia-K037-segura'
async function person(label) {
  const call = client()
  await call('GET', '/auth/session')
  const email = `k037-${label}-${randomUUID()}@example.invalid`
  assert.equal((await call('POST', '/auth/register', { email, password, privacyConsent: true })).status, 201)
  assert.equal((await call('POST', '/auth/login', { email, password })).status, 200)
  const { rows } = await database.query('SELECT id::text FROM users WHERE email = $1', [email])
  return { call, userId: rows[0].id }
}
const send = (who, reservation, text, idempotencyKey = randomUUID(), options) =>
  who.call('POST', `/reservations/${reservation}/messages`, { text, idempotencyKey }, options)
const read = (who, reservation, after = 0) => who.call('GET', `/reservations/${reservation}/messages?after=${after}`)
const stored = async reservation => (await database.query(
  `SELECT m.sequence, m.body, m.created_at, c.ended_at FROM chat_messages m
   JOIN commitments c ON c.id = m.commitment_id WHERE c.public_id = $1 ORDER BY m.sequence`, [reservation])).rows

/** Eventos de aviso de los mensajes de una reserva, como pares de tipo y destinatario */
const notices = async reservation => (await database.query(
  `SELECT e.event_type, e.recipient_user_id::text AS recipient, e.payload FROM outbox_events e
   JOIN chat_messages m ON m.id = e.subject_id JOIN commitments c ON c.id = m.commitment_id
   WHERE e.event_type LIKE 'message_from_%' AND c.public_id = $1 ORDER BY e.id`, [reservation])).rows

const pool = createPool({ connectionString })
const retention = createChatRetention(createChatRepository(pool), () => {})
const outbox = createOutboxProcessor(createOutboxRepository(pool), () => new Date(), () => 0.5)

try {
  await database.connect()
  const establishment = async name => (await database.query(`INSERT INTO establishments
    (name, address, latitude, longitude, time_zone) VALUES ($1, 'Santiago', -33.45, -70.66, 'America/Santiago')
    RETURNING id`, [name])).rows[0].id
  const shop = await establishment('K037 Panadería')
  const other = await establishment('K037 Otro local')
  const makeLot = async () => (await database.query(`INSERT INTO lots (establishment_id, description, category,
       quantity, address, latitude, longitude, time_zone, pickup_starts_at, pickup_ends_at, status, published_at)
     VALUES ($1, 'Pan del día K037', 'Panadería', 5, 'Santiago Centro', -33.45, -70.66, 'America/Santiago',
       now() - interval '1 hour', now() + interval '2 hours', 'published', now() - interval '2 hours')
     RETURNING public_id::text AS id`, [shop])).rows[0].id
  const operatorOf = async (label, establishmentId) => {
    const who = await person(label)
    await database.query('INSERT INTO memberships (user_id, establishment_id) VALUES ($1, $2)', [who.userId, establishmentId])
    return who
  }
  const reserve = async (who, lot = null) => {
    const lotId = lot ?? await makeLot()
    const created = await who.call('POST', `/public/lots/${lotId}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })
    assert.equal(created.status, 201)
    return { lotId, reservation: created.body.id }
  }

  const operator = await operatorOf('operadora', shop)
  const outsider = await person('ajena')
  const foreignOperator = await operatorOf('otro-local', other)

  // Titular y operador conversan, cada uno ve quién escribió y la consulta periódica trae solo lo nuevo
  const ana = await person('ana')
  const { lotId, reservation } = await reserve(ana)
  const empty = await read(operator, reservation)
  assert.deepEqual(empty.body, { items: [], hasMore: false, open: true }, 'la conversación se abre vacía')
  const first = await send(ana, reservation, '  Hola, paso a las 19 h  ')
  assert.equal(first.status, 201)
  assert.equal(first.body.sequence, 1)
  const reply = await send(operator, reservation, 'Perfecto, te esperamos')
  assert.equal(reply.body.sequence, 2)
  const seen = await read(operator, reservation)
  assert.deepEqual(seen.body.items.map(item => [item.sequence, item.author, item.mine, item.text]),
    [[1, 'holder', false, 'Hola, paso a las 19 h'], [2, 'operator', true, 'Perfecto, te esperamos']])
  assert.deepEqual((await read(ana, reservation, 1)).body.items.map(item => [item.text, item.mine]),
    [['Perfecto, te esperamos', false]], 'after recupera solo lo posterior a la última secuencia')
  ok('titular y operador conversan y la consulta por secuencia trae solo lo nuevo')

  // Reintentar con la misma clave no duplica, y reutilizarla para otra cosa es conflicto
  const key = randomUUID()
  const sent = await send(ana, reservation, '¿Traigo bolsa?', key)
  const retried = await send(ana, reservation, '  ¿Traigo bolsa?', key)
  assert.equal(retried.status, 201)
  assert.deepEqual(retried.body, sent.body)
  assert.equal((await send(ana, reservation, 'Otro texto', key)).status, 409)
  const anaOther = await reserve(ana)
  assert.equal((await send(ana, anaOther.reservation, '¿Traigo bolsa?', key)).status, 409)
  assert.equal((await stored(reservation)).length, 3)
  ok('repetir la clave devuelve el mismo mensaje y usarla con otro texto o reserva responde 409')

  // Cada mensaje nuevo avisa a la otra parte en la misma transacción, sin el texto, y el reintento no avisa otra vez
  const sentNotices = await notices(reservation)
  assert.deepEqual(sentNotices.map(row => [row.event_type, row.recipient]), [
    ['message_from_holder', operator.userId], ['message_from_establishment', ana.userId],
    ['message_from_holder', operator.userId]])
  assert.ok(!JSON.stringify(sentNotices).includes('bolsa') && !JSON.stringify(sentNotices).includes('19 h'))
  assert.equal(sentNotices[0].payload.reservationId, reservation)
  while (await outbox.processNext() > 0) { /* el worker vacía lo pendiente */ }
  const anaInbox = (await ana.call('GET', '/notifications')).body
  assert.deepEqual(anaInbox.items.filter(item => item.kind.startsWith('message_')).map(item => [item.kind, item.reservationId]),
    [['message_from_establishment', reservation]])
  assert.equal((await operator.call('GET', '/notifications')).body.items.filter(item => item.kind === 'message_from_holder').length, 2)
  ok('cada mensaje avisa una vez a la otra parte sin el texto y el worker lo deja en su bandeja')

  // Nadie fuera de la reserva lee ni escribe, ni siquiera un operador de otro local
  for (const stranger of [outsider, foreignOperator]) {
    assert.equal((await read(stranger, reservation)).status, 404)
    assert.equal((await send(stranger, reservation, 'Hola')).status, 404)
  }
  assert.equal((await read(ana, randomUUID())).status, 404)
  assert.equal((await stored(reservation)).length, 3)
  ok('una persona ajena o un operador de otro establecimiento reciben 404 sin escribir nada')

  // Validación del texto y de los parámetros
  for (const text of ['   ', 'a'.repeat(1001)]) assert.equal((await send(ana, anaOther.reservation, text)).status, 422)
  assert.equal((await send(ana, anaOther.reservation, 'ñ'.repeat(1000))).status, 201)
  assert.equal((await ana.call('POST', `/reservations/${reservation}/messages`, { text: 'hola' })).status, 422)
  assert.equal((await ana.call('GET', `/reservations/${reservation}/messages?after=-1`)).status, 422)
  assert.equal((await ana.call('GET', `/reservations/${reservation}/messages?page=2`)).status, 422)
  ok('texto vacío o de más de 1000 caracteres, campos ausentes y consultas inválidas responden 422')

  // Cupo de envíos por usuario con ráfaga de tres
  const bea = await person('bea')
  const beaChat = await reserve(bea)
  const burst = []
  for (let i = 0; i < 4; i++) burst.push(await send(bea, beaChat.reservation, `Mensaje ${i}`, randomUUID(), { wait: false }))
  assert.deepEqual(burst.map(result => result.status), [201, 201, 201, 429])
  assert.ok(Number(burst[3].retryAfter) >= 1)
  ok('el cuarto envío seguido recibe 429 con Retry-After')

  // Envíos simultáneos de ambos lados reciben secuencias únicas y seguidas
  const cata = await person('cata')
  const second = await operatorOf('segunda', shop)
  const busy = await reserve(cata)
  const results = await Promise.all([cata, operator, second].flatMap(who =>
    [1, 2, 3].map(n => send(who, busy.reservation, `Simultáneo ${n}`))))
  assert.ok(results.every(result => result.status === 201))
  assert.deepEqual((await stored(busy.reservation)).map(row => row.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  const fanOut = (await notices(busy.reservation)).map(row => `${row.event_type}:${row.recipient}`)
  assert.equal(fanOut.filter(item => item === `message_from_holder:${operator.userId}`).length, 3)
  assert.equal(fanOut.filter(item => item === `message_from_holder:${second.userId}`).length, 3)
  assert.equal(fanOut.filter(item => item === `message_from_establishment:${cata.userId}`).length, 6)
  assert.equal(fanOut.length, 12, 'lo que escribe un operador no avisa a su compañero')
  ok('nueve envíos simultáneos quedan con secuencias 1 a 9 y cada uno avisa solo a la otra parte')

  // Cancelar compite con enviar bajo el mismo bloqueo, así que ningún mensaje queda después del cierre
  const dani = await person('dani')
  const racing = await reserve(dani)
  const [cancelled, ...raced] = await Promise.all([
    dani.call('POST', `/reservations/${racing.reservation}/cancel`, {}),
    send(dani, racing.reservation, 'Antes de cancelar'), send(operator, racing.reservation, 'Mientras cancela'),
    send(second, racing.reservation, 'Justo al cancelar')])
  assert.equal(cancelled.status, 200)
  assert.ok(raced.every(result => [201, 409].includes(result.status)))
  const afterRace = await stored(racing.reservation)
  assert.equal(afterRace.length, raced.filter(result => result.status === 201).length)
  assert.ok(afterRace.every(row => row.created_at <= row.ended_at), 'ningún mensaje se guardó después de cancelar')
  ok('enviar durante una cancelación solo se acepta si llegó antes y nunca queda un mensaje posterior')

  // Una conversación cerrada no admite envíos pero conserva su historial, y el reintento sigue funcionando
  const cancelResult = await ana.call('POST', `/reservations/${reservation}/cancel`, {})
  assert.equal(cancelResult.status, 200)
  const closed = await read(operator, reservation)
  assert.equal(closed.body.open, false)
  assert.equal(closed.body.items.length, 3)
  const refused = await send(operator, reservation, '¿Sigues ahí?')
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'CONFLICT')
  assert.deepEqual((await send(ana, reservation, '¿Traigo bolsa?', key)).body, sent.body)
  ok('cancelar impide enviar, el historial sigue visible y el reintento original responde igual')

  // Vencer la ventana cierra aunque el worker no lo haya registrado, y retirar el lote también
  const eli = await person('eli')
  const expiring = await reserve(eli)
  await database.query(`UPDATE lots SET pickup_starts_at = now() - interval '3 hours',
    pickup_ends_at = now() - interval '1 second' WHERE public_id = $1`, [expiring.lotId])
  assert.equal((await send(eli, expiring.reservation, 'Llego tarde')).status, 409)
  assert.equal((await read(eli, expiring.reservation)).body.open, false)
  const fran = await person('fran')
  const withdrawing = await reserve(fran)
  await database.query(`UPDATE lots SET status = 'withdrawn', closed_at = now() WHERE public_id = $1`, [withdrawing.lotId])
  assert.equal((await send(operator, withdrawing.reservation, 'Se retiró el lote')).status, 409)
  ok('una ventana vencida sin registrar o un lote retirado impiden enviar')

  // Retirar la reserva también cierra la conversación
  const gabi = await person('gabi')
  const picking = await reserve(gabi)
  const { pickupCode } = (await gabi.call('GET', `/reservations/${picking.reservation}`)).body
  assert.equal((await send(gabi, picking.reservation, 'Ya voy')).status, 201)
  const delivered = await operator.call('POST', `/lots/${picking.lotId}/pickups`,
    { reservationId: picking.reservation, code: pickupCode, idempotencyKey: randomUUID() })
  assert.equal(delivered.status, 201)
  assert.equal((await send(gabi, picking.reservation, 'Gracias')).status, 409)
  ok('después del retiro acreditado ya no se puede escribir')

  // La retención borra el texto pasado el plazo, conserva el resultado idempotente y no toca lo reciente
  await database.query(`UPDATE commitments SET ended_at = now() - interval '31 days', created_at = now() - interval '32 days'
    WHERE public_id = $1`, [reservation])
  assert.deepEqual((await read(ana, reservation)).body, { items: [], hasMore: false, open: false },
    'pasado el plazo no se muestra aunque el borrado diario no haya corrido')
  const erased = await retention.eraseExpired()
  assert.equal(erased, 3)
  assert.ok((await stored(reservation)).every(row => row.body === null))
  assert.ok((await stored(racing.reservation)).every(row => row.body !== null), 'lo cerrado hace poco se conserva')
  assert.deepEqual((await send(ana, reservation, '¿Traigo bolsa?', key)).body, sent.body)
  assert.equal(await retention.eraseExpired(), 0, 'borrar otra vez no cambia nada')
  ok('el borrado diario quita el texto vencido, conserva el reintento y repetirlo no hace nada')

  // Leer el chat no cambia la reserva ni el inventario
  const lot = (await database.query(`SELECT reserved_quantity, delivered_quantity FROM lots WHERE public_id = $1`, [lotId])).rows[0]
  assert.deepEqual(lot, { reserved_quantity: 0, delivered_quantity: 0 })
  ok('el chat no modifica el lote ni acredita entregas')

  console.log(`PASS K037 chat: ${checks} comprobaciones`)
} finally {
  await new Promise(resolve => server.close(resolve))
  await api.close()
  await pool.end()
  await database.end()
}
