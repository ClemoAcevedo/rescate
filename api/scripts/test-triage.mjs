// #97/#99/#142/#143: contrato, aislamiento, bloqueos observados y capacidad real de scrypt.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pg from 'pg'
import { createApi } from '../dist/composition.js'
import { createPasswordHasher } from '../dist/infrastructure/crypto/passwords.js'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createPhotoRepository } from '../dist/infrastructure/postgres/photo-repository.js'
import { createPhotoUseCases } from '../dist/application/photos/use-cases.js'
import { createLocalObjectStore } from '../dist/infrastructure/objects/local-object-store.js'
import { assertContract } from '../test/support/openapi.ts'
import { testRecovery } from './support/test-recovery.mjs'

assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/rescate_triage_test_/, 'Se requiere una base dedicada')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL })
const directory = await mkdtemp(join(tmpdir(), 'rescate-triage-'))
const origin = 'https://triage.example.test'
const password = 'Contraseña ficticia de integración triage'
let api, server, base

function client() {
  const cookies = new Map()
  let csrf
  return { async call(method, path, data, extra = {}) {
    const response = await fetch(base + path, { method, headers: {
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      ...(method === 'GET' ? {} : { origin, 'x-csrf-token': csrf }),
      ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...extra,
    }, body: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data) })
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0]; const index = pair.indexOf('=')
      cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    const body = response.status === 204 ? undefined : await response.json()
    if (body?.csrfToken) csrf = body.csrfToken
    assertContract(method, path, response, body)
    return { status: response.status, body, retryAfter: response.headers.get('retry-after') }
  } }
}

try {
  await db.connect(); await blocker.connect()
  const credential = await createPasswordHasher().hash(password)
  async function person(email) {
    const row = (await db.query('INSERT INTO users(email) VALUES ($1) RETURNING id', [email])).rows[0]
    await db.query(`INSERT INTO user_credentials(user_id,password_hash,password_salt,scrypt_n,scrypt_r,scrypt_p)
      VALUES ($1,$2,$3,$4,$5,$6)`, [row.id, Buffer.from(credential.hash), Buffer.from(credential.salt),
      credential.parameters.N, credential.parameters.r, credential.parameters.p])
    return row.id
  }
  const operator = await person('triage-operator@example.test')
  const outsider = await person('triage-outsider@example.test')
  const owned = []
  for (let n = 0; n < 45; n++) {
    const name = n === 44 ? 'Café Ñuñoa 100% real' : `Establecimiento ${String(n).padStart(2, '0')}`
    const row = (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
      VALUES ($1,$2,-33.45,-70.66,'America/Santiago') RETURNING id,public_id`, [name, `Dirección ${n}`])).rows[0]
    owned.push(row)
    await db.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)', [operator, row.id])
  }
  const foreign = (await db.query(`INSERT INTO establishments(name,address,latitude,longitude,time_zone)
    VALUES ('Ajeno','Dirección privada',-33.45,-70.66,'America/Santiago') RETURNING id,public_id`)).rows[0]
  await db.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)', [outsider, foreign.id])
  api = createApi({ ...process.env, NODE_ENV: 'test', RESCATE_ALLOWED_ORIGINS: origin,
    CSRF_SIGNING_KEY: randomBytes(32).toString('base64'), PICKUP_CODE_KEY: randomBytes(32).toString('base64'),
    PHOTO_STORAGE: 'local', PHOTO_LOCAL_DIR: directory }, () => {})
  server = api.app.listen(0, '127.0.0.1'); await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
  const a = client(), b = client(), anonymous = client()
  for (const [who, email] of [[a, 'triage-operator@example.test'], [b, 'triage-outsider@example.test']]) {
    await who.call('GET', '/auth/session')
    assert.equal((await who.call('POST', '/auth/login', { email, password })).status, 200)
  }
  const session = await a.call('GET', '/auth/session')
  assert.equal(session.body.session.operableEstablishments.length, 20, 'la sesión permanece acotada')
  const pages = []
  for (let page = 1; page <= 3; page++) {
    const result = await a.call('GET', `/establishments?page=${page}`)
    assert.equal(result.status, 200); assert.equal(result.body.hasNextPage, page < 3)
    pages.push(...result.body.items)
  }
  assert.equal(pages.length, 45); assert.equal(new Set(pages.map(item => item.id)).size, 45)
  assert.ok(pages.every(item => item.address && item.latitude === -33.45 && item.timeZone === 'America/Santiago'))
  const accented = await a.call('GET', '/establishments?query=cafe%20nunoa')
  assert.equal(accented.body.items.length, 1)
  assert.equal((await a.call('GET', '/establishments?query=%25')).body.items.length, 1, '% no funciona como comodín')
  assert.equal((await a.call('GET', `/establishments/${foreign.public_id}`)).status, 404)
  assert.equal((await anonymous.call('GET', '/establishments')).status, 401)
  assert.equal((await a.call('GET', '/establishments?page=1&page=2')).status, 422)
  assert.equal((await a.call('GET', '/establishments?unknown=x')).status, 422)
  console.log('PASS #97/#99: sesión de 20, 45 establecimientos en 3 páginas, precarga, tildes, comodines literales, permisos y consultas inválidas')

  const estate = owned[0]
  const lot = (await db.query(`INSERT INTO lots(establishment_id,description,category,quantity,address,latitude,longitude,
    time_zone,pickup_starts_at,pickup_ends_at) VALUES ($1,'Lote de bloqueo','Prueba',1,'Santiago',-33.45,-70.66,
    'America/Santiago',now()+interval '1 hour',now()+interval '2 hours') RETURNING id,public_id`, [estate.id])).rows[0]
  await blocker.query('BEGIN')
  await blocker.query('SELECT id FROM lots WHERE id=$1 FOR UPDATE', [lot.id])
  const timeout = setTimeout(() => {}, 1000)
  try {
    const results = await Promise.race([
      Promise.all([
        b.call('PATCH', `/lots/${lot.public_id}`, { version: 1, description: 'Cambio ajeno' }),
        b.call('POST', `/lots/${lot.public_id}/publish`, { version: 1 }),
        b.call('POST', `/lots/${lot.public_id}/photos`, 'no leído', { 'content-type': 'image/png' }),
        b.call('DELETE', `/lots/${lot.public_id}/photos/${randomUUID()}`),
      ]),
      new Promise((_, reject) => { setTimeout(() => reject(new Error('El rechazo esperó el bloqueo del lote')), 1200).unref() }),
    ])
    assert.ok(results.every(result => result.status === 403))
    const waiting = (await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`)).rows[0].n
    assert.equal(waiting, 0)
    const pending = a.call('PATCH', `/lots/${lot.public_id}`, { version: 1, description: 'Cambio autorizado inicialmente' })
    let observed = false
    for (let n = 0; n < 100 && !observed; n++) {
      observed = (await db.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock') AS waiting`)).rows[0].waiting
      if (!observed) await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(observed, true, 'se observa la espera real del operador autorizado')
    await db.query('DELETE FROM memberships WHERE user_id=$1 AND establishment_id=$2', [operator, estate.id])
    await blocker.query('ROLLBACK')
    assert.equal((await pending).status, 403, 'se vuelve a comprobar la membership después del bloqueo')
    assert.equal((await db.query('SELECT description FROM lots WHERE id=$1', [lot.id])).rows[0].description, 'Lote de bloqueo')
  } finally { clearTimeout(timeout); await blocker.query('ROLLBACK') }
  console.log('PASS #143: cuatro rechazos sin esperar el lote bloqueado; revocación durante una espera observada impide escribir')
  const photoPool = createPool({ connectionString: process.env.DATABASE_URL })
  try {
    await db.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)', [operator, estate.id])
    const photos = createPhotoUseCases({ repository: createPhotoRepository(photoPool), objects: createLocalObjectStore(directory),
      images: null, now: () => new Date() })
    await assert.rejects(photos.upload({ userId: String(operator) }, { lotId: lot.public_id, readContent: async () => {
      await db.query('DELETE FROM memberships WHERE user_id=$1 AND establishment_id=$2', [operator, estate.id])
      return new Uint8Array(Buffer.from('89504e470d0a1a0a00000000', 'hex'))
    } }), error => error.code === 'not_authorized')
    const active = (await db.query("SELECT count(*)::int AS n FROM lot_photos WHERE lot_id=$1 AND removed_at IS NULL", [lot.id])).rows[0].n
    assert.equal(active, 0, 'revocar durante la recepción impide confirmar y limpia la carga')
    console.log('PASS #143: permiso revocado durante la recepción de bytes impide confirmar la foto y libera el cupo')
  } finally { await photoPool.end() }

  await anonymous.call('GET', '/auth/session')
  const burst = Array.from({ length: 35 }, (_, n) => anonymous.call('POST', '/auth/register', {
    email: `triage-burst-${n}@example.test`, password, privacyConsent: true,
  }))
  const login = a.call('POST', '/auth/login', { email: 'triage-operator@example.test', password })
  const results = await Promise.all(burst)
  assert.equal((await login).status, 200, 'el registro no deja al login sin capacidad de scrypt')
  assert.ok(results.some(result => result.status === 201))
  assert.ok(results.some(result => result.status === 429 && Number(result.retryAfter) > 0))
  assert.ok(results.every(result => [201, 429, 503].includes(result.status)))
  console.log('PASS #142: ráfaga real de 35 registros acotada con Retry-After; login concurrente 200')
  await testRecovery(process.env.DATABASE_URL)
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  await api?.close()
  await blocker.end().catch(() => {}); await db.end().catch(() => {})
  await rm(directory, { recursive: true, force: true })
}
