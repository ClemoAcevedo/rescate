// Prueba de integración contra una base aislada y ya migrada.
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import pg from 'pg'
import { createApi } from '../dist/composition.js'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_(k016_test|web_test_)/.test(new URL(connectionString).pathname.slice(1)),
  'Se requiere base de prueba aislada K016 o web')
const database = new pg.Client({ connectionString })
const api = createApi({ ...process.env, RESCATE_ALLOWED_ORIGINS: 'https://localhost:5173',
  CSRF_SIGNING_KEY: randomBytes(32).toString('base64') })
const server = api.app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
let checks = 0
const ok = label => console.log(`OK ${++checks}: ${label}`)
const base = `http://127.0.0.1:${server.address().port}`
function client() {
  const cookies = new Map()
  let csrf = ''
  return async (method, path, body) => {
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
    return { status: response.status, body: result }
  }
}
try {
  await database.connect()
  const establishment = await database.query(`INSERT INTO establishments
    (name, address, latitude, longitude, time_zone) VALUES ('K016', 'Santiago', -33.45, -70.66, 'America/Santiago')
    RETURNING id`)
  const lot = await database.query(`INSERT INTO lots
    (establishment_id, description, category, quantity, address, latitude, longitude, time_zone,
     pickup_starts_at, pickup_ends_at, status, published_at)
    VALUES ($1, 'Pack de prueba', 'Panadería', 2, 'Santiago Centro', -33.45, -70.66,
      'America/Santiago', now() + interval '1 hour', now() + interval '3 hours', 'published', now())
    RETURNING public_id::text AS id`, [establishment.rows[0].id])
  const lotId = lot.rows[0].id
  const guest = client()
  const listing = await guest('GET', '/public/lots?category=Panader%C3%ADa&latitude=-33.45&longitude=-70.66&radiusKm=5')
  assert.equal(listing.status, 200)
  assert.equal(listing.body.items.some(item => item.id === lotId), true)
  assert.equal(listing.body.items.find(item => item.id === lotId).availableQuantity, 2)
  ok('visitante busca por categoría y zona manual sin sesión')
  const detail = await guest('GET', `/public/lots/${lotId}`)
  assert.equal(detail.status, 200); assert.equal(detail.body.photoUrl, null)
  assert.equal((await guest('POST', `/public/lots/${lotId}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })).status, 401)
  ok('detalle público y reserva protegida')

  const buyer = client()
  assert.equal((await buyer('GET', '/auth/session')).status, 200)
  const email = `k016-${randomUUID()}@example.invalid`
  assert.equal((await buyer('POST', '/auth/register', { email, password: 'Clave-ficticia-K016-segura' })).status, 201)
  assert.equal((await buyer('POST', '/auth/login', { email, password: 'Clave-ficticia-K016-segura' })).status, 200)
  const key = randomUUID()
  const confirmed = await buyer('POST', `/public/lots/${lotId}/reservations`, { quantity: 2, idempotencyKey: key })
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body))
  assert.equal(confirmed.body.status, 'confirmed')
  const replay = await buyer('POST', `/public/lots/${lotId}/reservations`, { quantity: 2, idempotencyKey: key })
  assert.equal(replay.status, 200); assert.equal(replay.body.id, confirmed.body.id)
  assert.equal((await buyer('POST', `/public/lots/${lotId}/reservations`, { quantity: 1, idempotencyKey: key })).status, 409)
  ok('login, reserva real e idempotencia de reintento')

  const other = client()
  await other('GET', '/auth/session')
  const otherEmail = `k016-${randomUUID()}@example.invalid`
  await other('POST', '/auth/register', { email: otherEmail, password: 'Clave-ficticia-K016-segura' })
  await other('POST', '/auth/login', { email: otherEmail, password: 'Clave-ficticia-K016-segura' })
  assert.equal((await other('POST', `/public/lots/${lotId}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })).status, 409)
  assert.equal((await guest('GET', `/public/lots/${lotId}`)).body.availableQuantity, 0)
  assert.equal((await database.query('SELECT count(*)::int AS count FROM commitments WHERE lot_id = (SELECT id FROM lots WHERE public_id = $1)', [lotId])).rows[0].count, 1)
  ok('sin stock visible y segunda reserva rechazada sin sobreventa')

  const lastPack = await database.query(`INSERT INTO lots
    (establishment_id, description, category, quantity, address, latitude, longitude, time_zone,
     pickup_starts_at, pickup_ends_at, status, published_at)
    VALUES ($1, 'Último pack', 'Panadería', 1, 'Santiago Centro', -33.45, -70.66,
      'America/Santiago', now() + interval '1 hour', now() + interval '3 hours', 'published', now())
    RETURNING public_id::text AS id`, [establishment.rows[0].id])
  const raceId = lastPack.rows[0].id
  const race = await Promise.all([
    buyer('POST', `/public/lots/${raceId}/reservations`, { quantity: 1, idempotencyKey: randomUUID() }),
    other('POST', `/public/lots/${raceId}/reservations`, { quantity: 1, idempotencyKey: randomUUID() }),
  ])
  assert.deepEqual(race.map(result => result.status).sort(), [201, 409])
  assert.equal((await guest('GET', `/public/lots/${raceId}`)).body.availableQuantity, 0)
  ok('dos personas compiten por el último pack: solo una reserva confirma')
} finally {
  await database.end().catch(() => {})
  await new Promise(resolve => server.close(resolve))
  await api.close()
}
