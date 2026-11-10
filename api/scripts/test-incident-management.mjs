// K046: gestión de incidencias del operador con PostgreSQL real y contrato HTTP: listado por
// establecimiento, responsable de cada versión y avisos pendientes, generados y leídos.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { createApi } from '../dist/composition.js'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createIncidentDispatchRepository } from '../dist/infrastructure/postgres/incident-repository.js'
import { createIncidentDispatcher } from '../dist/application/incidents/use-cases.js'
import { createOutboxRepository } from '../dist/infrastructure/postgres/notification-repository.js'
import { createOutboxProcessor } from '../dist/application/notifications/use-cases.js'
import { assertContract } from '../test/support/openapi.ts'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_k046_test_/.test(new URL(connectionString).pathname.slice(1)), 'Solo base dedicada K046')
const db = new pg.Client({ connectionString })
const pool = createPool({ connectionString })
const api = createApi({ DATABASE_URL: connectionString, RESCATE_ALLOWED_ORIGINS: 'https://localhost:5173',
  CSRF_SIGNING_KEY: randomBytes(32).toString('base64'), PICKUP_CODE_KEY: randomBytes(32).toString('base64') }, () => {})
const server = api.app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const dispatcher = createIncidentDispatcher(createIncidentDispatchRepository(pool))
const processor = createOutboxProcessor(createOutboxRepository(pool), () => new Date())

function client() {
  let csrf = ''; const cookies = new Map()
  return async function call(method, path, body) {
    const response = await fetch(base + path, { method, headers: {
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET' ? {} : { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf }),
    }, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const line of response.headers.getSetCookie()) { const pair = line.split(';')[0]; const at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1)) }
    const result = await response.json(); if (result.csrfToken) csrf = result.csrfToken
    assertContract(method, path, response, result)
    return { status: response.status, body: result }
  }
}

let count = 0
const ok = label => console.log(`OK K046 ${++count}: ${label}`)

try {
  await db.connect()
  async function person() {
    const call = client(), email = `k046-${randomUUID()}@example.invalid`, password = 'Clave-segura-k046-fixture'
    await call('GET', '/auth/session')
    assert.equal((await call('POST', '/auth/register', { email, password, privacyConsent: true })).status, 201)
    assert.equal((await call('POST', '/auth/login', { email, password })).status, 200)
    return { call, email, userId: (await db.query('SELECT id::text FROM users WHERE email=$1', [email])).rows[0].id }
  }
  const establishment = async () => (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('K046','Santiago',-33.45,-70.66,'America/Santiago') RETURNING id::text, public_id::text`)).rows[0]
  const join = (actor, est) => db.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)', [actor.userId, est.id])
  const makeLot = async (est, description) => (await db.query(`INSERT INTO lots(establishment_id,description,category,quantity,
    address,latitude,longitude,time_zone,pickup_starts_at,pickup_ends_at,status,published_at)
    VALUES ($1,$2,'K046',3,'Santiago',-33.45,-70.66,'America/Santiago',now()-interval '1 hour',
      now()+interval '2 hours','published',now()) RETURNING public_id::text AS id`, [est.id, description])).rows[0].id
  const drain = async () => { while (await dispatcher.processNext()) {} while (await processor.processNext()) {} }
  const reason = 'El pan llegó con moho'
  const version = (action, current, extra = {}) => ({ action, version: current, reason: 'Pan con moho en el lote',
    instructions: 'No consumir y devolver en el local', idempotencyKey: randomUUID(), ...extra })

  const est = await establishment(), otherEst = await establishment()
  const first = await person(), second = await person(), holder = await person(), outsider = await person()
  await join(first, est); await join(second, est); await join(outsider, otherEst)
  const lot = await makeLot(est, 'Pan del día'), otherLot = await makeLot(est, 'Verduras de temporada')
  const listPath = `/establishments/${est.public_id}/incidents`
  assert.equal((await holder.call('POST', `/public/lots/${lot}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })).status, 201)

  // Permisos y consulta estricta por HTTP real.
  assert.equal((await client()('GET', listPath)).status, 401)
  assert.equal((await outsider.call('GET', listPath)).status, 403)
  assert.equal((await holder.call('GET', listPath)).status, 403)
  assert.equal((await first.call('GET', `/establishments/${randomUUID()}/incidents`)).status, 404)
  assert.equal((await first.call('GET', '/establishments/no-uuid/incidents')).status, 404)
  for (const query of ['status=closed', 'page=0', 'page=1001', 'lotId=x', 'status=open&status=resolved']) {
    assert.equal((await first.call('GET', `${listPath}?${query}`)).status, 422, query)
  }
  ok('solo operadores actuales del establecimiento; 401/403/404 y consulta estricta (422)')

  // El reporte de quien reservó llega al operador con su lote, sin identificar a nadie.
  const reported = await holder.call('POST', `/lots/${lot}/incidents`, { reason, idempotencyKey: randomUUID() })
  assert.equal(reported.status, 201)
  let page = await first.call('GET', `${listPath}?status=reported`)
  assert.equal(page.status, 200)
  assert.deepEqual(page.body.items.map(item => [item.id, item.status, item.reportReason, item.lot]),
    [[reported.body.id, 'reported', reason, { id: lot, description: 'Pan del día' }]])
  assert.deepEqual(page.body.items[0].versions, [])
  assert.deepEqual((await first.call('GET', `${listPath}?status=open`)).body.items, [])
  assert.doesNotMatch(JSON.stringify(page.body), new RegExp(`${holder.email}|userId|pickupCode`))
  ok('el reporte de quien reservó aparece por revisar, con su lote y sin identidad de quien reportó')

  // Publicar: responsable y avisos pendientes, sin efecto automático del reporte.
  const published = await first.call('POST', `/incidents/${reported.body.id}/versions`, version('publish', 0))
  assert.equal(published.status, 201)
  const versionOf = async (number, path = listPath) =>
    (await first.call('GET', path)).body.items.find(item => item.id === reported.body.id).versions.find(item => item.version === number)
  let v1 = await versionOf(1)
  assert.equal(v1.publishedBy, first.email)
  assert.equal(v1.recipientCount, 3, 'quien reservó y los dos operadores')
  assert.deepEqual(v1.notices, { pending: 3, generated: 0, read: 0 })
  assert.deepEqual(await versionOf(1, `/lots/${lot}/incidents`), v1, 'el lote y el establecimiento muestran lo mismo')
  ok('cada versión informa quién la publicó y sus avisos pendientes; el listado del lote coincide')

  // El worker genera los avisos; leer uno lo mueve a leídos.
  await drain()
  v1 = await versionOf(1)
  assert.deepEqual(v1.notices, { pending: 0, generated: 3, read: 0 })
  const inbox = await holder.call('GET', '/notifications')
  const notice = inbox.body.items.find(item => item.kind === 'incident_version')
  assert.ok(notice, 'quien reservó recibió el aviso')
  assert.equal((await holder.call('POST', `/notifications/${notice.id}/read`, {})).status, 200)
  v1 = await versionOf(1)
  assert.deepEqual(v1.notices, { pending: 0, generated: 2, read: 1 })
  assert.equal(v1.notices.pending + v1.notices.generated + v1.notices.read, v1.recipientCount)
  ok('pendientes, generados y leídos siguen al worker y a la lectura de cada destinatario')

  // Otra operadora resuelve; cada versión conserva su responsable, motivo y fecha.
  const resolved = await second.call('POST', `/incidents/${reported.body.id}/versions`,
    version('resolve', 1, { reason: 'Se retiró el pan afectado', instructions: 'Puedes retirar un nuevo pack mañana' }))
  assert.equal(resolved.status, 201)
  const v2 = await versionOf(2)
  assert.deepEqual([v2.status, v2.publishedBy, v2.reason], ['resolved', second.email, 'Se retiró el pan afectado'])
  assert.equal(v2.publishedAt, resolved.body.publishedAt)
  assert.deepEqual((await versionOf(1)).notices, { pending: 0, generated: 2, read: 1 }, 'la versión anterior no cambia')
  await db.query('DELETE FROM memberships WHERE user_id = $1', [first.userId])
  assert.equal((await first.call('GET', listPath)).status, 403)
  const after = await second.call('GET', `${listPath}?status=resolved`)
  assert.equal(after.body.items[0].versions[0].publishedBy, first.email, 'el responsable se conserva aunque deje de ser miembro')
  await join(first, est)
  ok('la resolución conserva responsable, motivo y fecha; el historial no depende de la membresía actual')

  // Páginas de 20 del reporte más reciente al más antiguo.
  // Directo en SQL: el reporte por HTTP ya se probó y 21 seguidos superan la ráfaga de escrituras por persona.
  const extra = []
  for (let index = 0; index < 21; index++) {
    extra.push((await db.query(`INSERT INTO incidents (lot_id, reported_by, report_reason, idempotency_key, created_at)
      SELECT id, $2, $3, $4, clock_timestamp() FROM lots WHERE public_id = $1 RETURNING public_id::text AS id`,
    [otherLot, second.userId, `Reporte ${index}`, randomUUID()])).rows[0].id)
  }
  const one = await first.call('GET', listPath), two = await first.call('GET', `${listPath}?page=2`)
  assert.deepEqual([one.body.items.length, one.body.page, one.body.hasNextPage], [20, 1, true])
  assert.deepEqual([two.body.items.length, two.body.page, two.body.hasNextPage], [2, 2, false])
  assert.deepEqual([...one.body.items, ...two.body.items].map(item => item.id), [...extra.reverse(), reported.body.id])
  assert.deepEqual((await first.call('GET', `${listPath}?page=1000`)).body, { items: [], page: 1000, hasNextPage: false })
  assert.equal((await outsider.call('GET', `/establishments/${otherEst.public_id}/incidents`)).body.items.length, 0,
    'otro establecimiento no ve incidencias ajenas')
  ok('páginas de 20, más reciente primero y sin mezclar establecimientos')

  console.log(`PASS K046: ${count} grupos con PostgreSQL real y contrato HTTP`)
} finally {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  await api.close(); await pool.end(); await db.end()
}
