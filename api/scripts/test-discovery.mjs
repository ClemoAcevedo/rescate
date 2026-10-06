// Prueba de integración contra una base aislada y ya migrada.
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import pg from 'pg'
import { assertContract } from '../test/support/openapi.ts'
import { createDiscoveryRepository } from '../dist/infrastructure/postgres/discovery-repository.js'
import { createDiscoveryUseCases } from '../dist/application/discovery/use-cases.js'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createApi } from '../dist/composition.js'

const connectionString = process.env.DATABASE_URL
assert.ok(connectionString && /^rescate_(k015_test_|web_test_)/.test(new URL(connectionString).pathname.slice(1)),
  'Se requiere base de prueba aislada K015 o web')
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
  return async function call(method, path, body, overrides = {}, retry = 0) {
    const response = await fetch(`${base}${path}`, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(method === 'GET' ? {} : { Origin: 'https://localhost:5173', 'X-CSRF-Token': csrf }), ...overrides },
      body: body === undefined ? undefined : JSON.stringify(body) })
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';'); const at = pair.indexOf('=')
      cookies.set(pair.slice(0, at), pair.slice(at + 1))
    }
    const result = await response.json()
    if (result.csrfToken) csrf = result.csrfToken
    assertContract(method, path, response, result)
    // La suite supera la ráfaga de una persona. Respetar Retry-After sin desactivar seguridad.
    if (response.status === 429 && retry < 3) {
      await new Promise(resolve => setTimeout(resolve, Number(response.headers.get('retry-after')) * 1000))
      return call(method, path, body, overrides, retry + 1)
    }
    return { status: response.status, body: result }
  }
}
try {
  await database.connect()
  const establishment = await database.query(`INSERT INTO establishments
    (name, address, latitude, longitude, time_zone) VALUES ('K015', 'Santiago', -33.45, -70.66, 'America/Santiago')
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
  const email = `k015-${randomUUID()}@example.invalid`
  assert.equal((await buyer('POST', '/auth/register', { email, password: 'Clave-ficticia-K015-segura' })).status, 201)
  assert.equal((await buyer('POST', '/auth/login', { email, password: 'Clave-ficticia-K015-segura' })).status, 200)
  const key = randomUUID()
  const confirmed = await buyer('POST', `/public/lots/${lotId}/reservations`, { quantity: 2, idempotencyKey: key })
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body))
  assert.equal(confirmed.body.status, 'confirmed')
  const replay = await buyer('POST', `/public/lots/${lotId}/reservations`, { quantity: 2, idempotencyKey: key })
  assert.equal(replay.status, 201); assert.deepEqual(replay.body, confirmed.body)
  assert.equal((await buyer('POST', `/public/lots/${lotId}/reservations`, { quantity: 1, idempotencyKey: key })).status, 409)
  ok('login, reserva real e idempotencia de reintento')

  const other = client()
  await other('GET', '/auth/session')
  const otherEmail = `k015-${randomUUID()}@example.invalid`
  await other('POST', '/auth/register', { email: otherEmail, password: 'Clave-ficticia-K015-segura' })
  await other('POST', '/auth/login', { email: otherEmail, password: 'Clave-ficticia-K015-segura' })
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

  // Más de una página, radio PostGIS, distancia, ventanas y visibilidad.
  const makeLot = async (description, quantity = 5, latitude = -33.45, longitude = -70.66,
    status = 'published', starts = new Date(Date.now() + 3600000), ends = new Date(Date.now() + 10800000)) => {
    const { rows } = await database.query(`INSERT INTO lots
      (establishment_id, description, category, quantity, address, latitude, longitude, time_zone,
       pickup_starts_at, pickup_ends_at, status, published_at)
      VALUES ($1,$2,'Filtro K015',$3,'Santiago',$4,$5,'America/Santiago',$6,$7,$8,
        CASE WHEN $8='published' THEN now() ELSE NULL END) RETURNING public_id::text AS id`,
      [establishment.rows[0].id, description, quantity, latitude, longitude, starts, ends, status])
    return rows[0].id
  }
  const nearIds = []
  for (let i = 0; i < 14; i++) nearIds.push(await makeLot(`Cerca ${i}`, 5, -33.45 + i / 10000))
  const far = await makeLot('Lejos', 5, -34.45)
  const draft = await makeLot('Borrador', 5, -33.45, -70.66, 'draft')
  const expired = await makeLot('Cerrado', 5, -33.45, -70.66, 'published',
    new Date(Date.now() - 7200000), new Date(Date.now() - 3600000))
  const filter = '/public/lots?category=Filtro%20K015&latitude=-33.45&longitude=-70.66&radiusKm=1'
  const first = await guest('GET', filter)
  const second = await guest('GET', filter + '&page=2')
  assert.equal(first.body.items.length, 12); assert.equal(first.body.hasNextPage, true)
  assert.equal(second.body.items.length, 2); assert.equal(second.body.hasNextPage, false)
  assert.deepEqual(new Set([...first.body.items, ...second.body.items].map(x => x.id)), new Set(nearIds))
  assert.deepEqual(first.body, (await guest('GET', filter)).body)
  assert.equal(first.body.items[0].distanceKm, 0)
  assert.ok(first.body.items.every((x, i, all) => i === 0 || x.distanceKm >= all[i-1].distanceKm))
  const precise = await database.query(`SELECT ST_Distance(
    ST_SetSRID(ST_MakePoint(-70.66,-33.45),4326)::geography,
    ST_SetSRID(ST_MakePoint(-70.66,-34.45),4326)::geography)/1000 AS km`)
  assert.ok(precise.rows[0].km > 110 && precise.rows[0].km < 112)
  assert.equal((await guest('GET', '/public/lots?pickupBefore=' + encodeURIComponent(new Date().toISOString()))).body.items.length, 0)
  for (const id of [draft, expired, randomUUID(), 'invalido']) {
    assert.equal((await guest('GET', `/public/lots/${id}`)).status, 404)
  }
  assert.equal((await guest('GET', `/public/lots/${far}`)).status, 200)
  assert.equal((await guest('GET', '/public/lots')).body.items[0].distanceKm, null)
  ok('PostGIS, orden estable, paginación, categoría, ventana y exclusión de borradores/cerrados')

  for (const query of ['latitude=91&longitude=0', 'latitude=0', 'radiusKm=5', 'page=1.5',
    'page=0', 'page=1001', 'page=1&page=2', 'latitude=NaN&longitude=0', 'latitude=0x10&longitude=0',
    'pickupBefore=2030-02-30T10:00:00Z', 'pickupBefore=2030-01-01', 'unknown=1']) {
    assert.equal((await guest('GET', '/public/lots?' + query)).status, 422, query)
  }
  const freshId = nearIds[0]
  const path = `/public/lots/${freshId}/reservations`
  for (const quantity of [0, -1, 0.5, 2147483648, '1', null]) {
    assert.equal((await buyer('POST', path, { quantity, idempotencyKey: randomUUID() })).status, 422)
  }
  assert.equal((await buyer('POST', path, { quantity: 1, idempotencyKey: 'bad' })).status, 422)
  assert.equal((await buyer('POST', path, { quantity: 1, idempotencyKey: randomUUID(), userId: '2' })).status, 422)
  assert.equal((await buyer('POST', path, { quantity: 1, idempotencyKey: randomUUID() }, { Origin: 'https://foreign.invalid' })).status, 403)
  assert.equal((await buyer('POST', path, { quantity: 1, idempotencyKey: randomUUID() }, { 'X-CSRF-Token': 'bad' })).status, 403)
  assert.equal((await buyer('POST', path, { quantity: 1, idempotencyKey: randomUUID() }, { 'Content-Type': 'text/plain' })).status, 415)
  assert.equal((await buyer('POST', `/public/lots/${draft}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })).status, 404)
  assert.equal((await buyer('POST', `/public/lots/${expired}/reservations`, { quantity: 1, idempotencyKey: randomUUID() })).status, 409)
  ok('entradas inválidas, actor inyectado, sesión, Origin, CSRF y ventana rechazan sin escribir')

  const repeatedKey = randomUUID()
  const parallel = await Promise.all([
    buyer('POST', path, { quantity: 3, idempotencyKey: repeatedKey }),
    buyer('POST', path.replace(freshId, freshId.toUpperCase()), { quantity: 3, idempotencyKey: repeatedKey.toUpperCase() }),
  ])
  assert.deepEqual(parallel.map(r => r.status), [201, 201])
  assert.deepEqual(parallel[0].body, parallel[1].body)
  assert.equal((await buyer('POST', path, { quantity: 1, idempotencyKey: randomUUID() })).status, 409)
  assert.equal((await buyer('POST', `/public/lots/${nearIds[1]}/reservations`, { quantity: 3, idempotencyKey: repeatedKey })).status, 409)
  assert.equal((await other('POST', path, { quantity: 1, idempotencyKey: repeatedKey })).status, 201)
  await database.query("UPDATE lots SET pickup_starts_at=now()-interval '2 hours', pickup_ends_at=now()-interval '1 hour' WHERE public_id=$1", [freshId])
  assert.deepEqual((await buyer('POST', path, { quantity: 3, idempotencyKey: repeatedKey })).body, parallel[0].body)
  ok('reintentos simultáneos/capitalización, parámetros distintos, clave por actor y replay tras cierre')

  const pool = createPool({ connectionString })
  const repository = createDiscoveryRepository(pool)
  const buyerId = (await database.query('SELECT id::text FROM users WHERE email=$1', [email])).rows[0].id
  try {
    const failing = createDiscoveryUseCases({ ...repository,
      withReservationTransaction: (user, lot, key, operate) => repository.withReservationTransaction(user, lot, key,
        (state, writer) => operate(state, { insert: async (...args) => {
          await writer.insert(...args); throw new Error('fallo posterior a inserción')
        } })),
    }, () => new Date())
    const rollbackKey = randomUUID()
    await assert.rejects(failing.reserve({ userId: buyerId }, nearIds[2], 1, rollbackKey), /fallo posterior/)
    assert.equal((await database.query('SELECT count(*)::int n FROM commitments WHERE user_id=$1 AND idempotency_key=$2', [buyerId, rollbackKey])).rows[0].n, 0)
    assert.equal((await database.query('SELECT reserved_quantity FROM lots WHERE public_id=$1', [nearIds[2]])).rows[0].reserved_quantity, 0)
    const cases = createDiscoveryUseCases(repository, () => new Date())
    const original = await cases.reserve({ userId: buyerId }, nearIds[2], 1, rollbackKey)
    const replayAfterRestart = createDiscoveryUseCases(createDiscoveryRepository(pool), () => new Date())
    assert.deepEqual(await replayAfterRestart.reserve({ userId: buyerId }, nearIds[2], 1, rollbackKey), original)
    ok('rollback de reserva y clave juntos; relectura desde otra instancia conserva el resultado')

    // Bloqueo real: la solicitud debe esperar y releer el cierre confirmado por otra transacción.
    await database.query('BEGIN')
    await database.query('SELECT id FROM lots WHERE public_id=$1 FOR UPDATE', [nearIds[3]])
    const waiting = cases.reserve({ userId: buyerId }, nearIds[3], 1, randomUUID()).then(
      value => ({ value }), error => ({ error }))
    let isBlocked = false
    for (let i = 0; i < 100; i++) {
      const locks = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM public.lots WHERE public_id%'")
      if (locks.rowCount) { isBlocked = true; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(isBlocked, true, 'reserva debe esperar el bloqueo real')
    await database.query("UPDATE lots SET pickup_starts_at=now()-interval '2 hours', pickup_ends_at=now()-interval '1 hour' WHERE public_id=$1", [nearIds[3]])
    await database.query('COMMIT')
    const result = await waiting
    assert.equal(result.error?.reason, 'unavailable')
    assert.equal((await database.query('SELECT count(*)::int n FROM commitments WHERE lot_id=(SELECT id FROM lots WHERE public_id=$1)', [nearIds[3]])).rows[0].n, 0)
    ok('relectura de estado y reloj después de esperar bloqueo impide reserva vencida')

    await database.query('BEGIN')
    await database.query('SELECT id FROM lots WHERE public_id=$1 FOR UPDATE', [nearIds[4]])
    const timeoutKey = randomUUID()
    await assert.rejects(cases.reserve({ userId: buyerId }, nearIds[4], 1, timeoutKey), { code: '55P03' })
    await database.query('ROLLBACK')
    await cases.reserve({ userId: buyerId }, nearIds[4], 1, timeoutKey)
    ok('bloqueo mayor a 2 s aborta sin consumir clave; se puede reintentar después')

    // K021: ocho personas compiten por cinco packs y cada una reintenta tres veces
    // en paralelo con su clave. Cada intención obtiene un único resultado.
    const contested = await makeLot('Contienda K021', 5)
    const people = []
    for (let i = 0; i < 8; i++) {
      const { rows } = await database.query('INSERT INTO users(email) VALUES ($1) RETURNING id::text', [`k021-${randomUUID()}@example.invalid`])
      people.push({ userId: rows[0].id, key: randomUUID() })
    }
    const settle = promise => promise.then(value => ({ value }), error => ({ error }))
    const attempts = await Promise.all(people.flatMap(person => [0, 1, 2].map(() =>
      settle(cases.reserve({ userId: person.userId }, contested, 1, person.key)))))
    const outcomes = people.map((_, i) => attempts.slice(i * 3, i * 3 + 3))
    for (const tries of outcomes) {
      const won = tries.filter(t => t.value)
      if (won.length) {
        // La intención confirmada se reproduce idéntica en todos sus reintentos exitosos.
        assert.ok(won.every(t => t.value.id === won[0].value.id))
        assert.ok(tries.every(t => t.value || t.error?.reason === 'unavailable'))
      } else assert.ok(tries.every(t => t.error?.reason === 'unavailable'), JSON.stringify(tries))
    }
    const winners = outcomes.filter(tries => tries.some(t => t.value))
    assert.equal(winners.length, 5)
    const [counts] = (await database.query(`SELECT l.free_quantity, l.reserved_quantity,
        (SELECT count(*)::int FROM commitments c WHERE c.lot_id = l.id) AS commitments
      FROM lots l WHERE public_id = $1`, [contested])).rows
    assert.deepEqual(counts, { free_quantity: 0, reserved_quantity: 5, commitments: 5 })
    // Una respuesta perdida se recupera repitiendo la clave: mismo resultado, sin otra reserva.
    for (const [i, tries] of outcomes.entries()) {
      const original = tries.find(t => t.value)?.value
      if (original) assert.deepEqual(await cases.reserve({ userId: people[i].userId }, contested, 1, people[i].key), original)
    }
    assert.equal((await database.query('SELECT reserved_quantity FROM lots WHERE public_id=$1', [contested])).rows[0].reserved_quantity, 5)
    ok('reintentos concurrentes de 8 personas por 5 packs: un resultado por clave, sin sobreasignación')

    // Si la regla fallara, la base igual rechaza dejar F negativo y revierte todo.
    const blind = createDiscoveryUseCases({ ...repository,
      withReservationTransaction: (user, lot, key, operate) => repository.withReservationTransaction(user, lot, key,
        (state, writer) => operate(state.lot ? { ...state, lot: { ...state.lot, availableQuantity: 99 } } : state, writer)),
    }, () => new Date())
    const blindKey = randomUUID()
    await assert.rejects(blind.reserve({ userId: buyerId }, contested, 1, blindKey), { constraint: 'lots_inventory_total_check' })
    assert.equal((await database.query('SELECT count(*)::int n FROM commitments WHERE idempotency_key=$1', [blindKey])).rows[0].n, 0)
    ok('CHECK de inventario rechaza sobreasignación aunque Application no la detecte; clave sin consumir')

    // Contadores distintos de sus registros: no se asigna y queda un registro para revisión.
    const tampered = await makeLot('Discrepancia K021', 5)
    await database.query('UPDATE lots SET reserved_quantity = 1 WHERE public_id = $1', [tampered])
    const discrepancyKey = randomUUID()
    await assert.rejects(cases.reserve({ userId: buyerId }, tampered, 1, discrepancyKey), { code: 'inventory_discrepancy', lotId: tampered })
    const logged = []
    const originalError = console.error
    console.error = entry => logged.push(entry)
    let refused
    try { refused = await other('POST', `/public/lots/${tampered}/reservations`, { quantity: 1, idempotencyKey: randomUUID() }) }
    finally { console.error = originalError }
    assert.equal(refused.status, 409)
    assert.ok(logged.some(entry => entry?.event === 'inventory_discrepancy' && entry.lotId === tampered), JSON.stringify(logged))
    assert.equal((await database.query('SELECT count(*)::int n FROM commitments WHERE lot_id=(SELECT id FROM lots WHERE public_id=$1)', [tampered])).rows[0].n, 0)
    await database.query('UPDATE lots SET reserved_quantity = 0 WHERE public_id = $1', [tampered])
    await cases.reserve({ userId: buyerId }, tampered, 1, discrepancyKey)
    ok('discrepancia entre R y reservas bloquea nuevas asignaciones con 409 y registra revisión')

    const unreconciled = await database.query(`SELECT l.public_id FROM lots l
      WHERE l.reserved_quantity <> COALESCE((SELECT sum(c.quantity) FROM commitments c
        WHERE c.lot_id = l.id AND c.status = 'confirmed'), 0)
        OR l.free_quantity <> l.quantity - l.offered_quantity - l.reserved_quantity - l.delivered_quantity - l.expired_quantity`)
    assert.deepEqual(unreconciled.rows, [])
    ok('conciliación: R coincide con las reservas confirmadas en todos los lotes')
  } finally {
    await database.query('ROLLBACK')
    await pool.end()
  }
  console.log(`PASS K015/K021: ${checks} grupos de integración con PostgreSQL/PostGIS real`)

} finally {
  await database.end().catch(() => {})
  await new Promise(resolve => server.close(resolve))
  await api.close()
}
