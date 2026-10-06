// K014 · Integración real: PostgreSQL, objetos locales y sharp sobre los casos de uso.
// Destructiva solo en una base dedicada rescate_k014_test_*, creada vacía.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import sharp from 'sharp'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createLotRepository } from '../dist/infrastructure/postgres/lot-repository.js'
import { createPhotoRepository } from '../dist/infrastructure/postgres/photo-repository.js'
import { createDiscoveryRepository } from '../dist/infrastructure/postgres/discovery-repository.js'
import { createLocalObjectStore } from '../dist/infrastructure/objects/local-object-store.js'
import { createSharpImageProcessor } from '../dist/infrastructure/images/sharp-image-processor.js'
import { createLotUseCases } from '../dist/application/lots/use-cases.js'
import { createPhotoUseCases, PROCESSING_LEASE_MS } from '../dist/application/photos/use-cases.js'
import { createDiscoveryUseCases } from '../dist/application/discovery/use-cases.js'
import { createPickupCodes } from '../dist/infrastructure/crypto/pickup-codes.js'
import { photoObjectKeys } from '../dist/domain/photos.js'
import { createApi } from '../dist/composition.js'
import { assertContract } from '../test/support/openapi.ts'
import { randomBytes } from 'node:crypto'
import { animatedWebp, fakePng, jpegWithExif, limitJpeg, pngOf, svg } from '../test/support/images.ts'

// Memoria residente del proceso hijo en MiB. Linux expone el pico (VmHWM) en
// /proc; macOS y BSD no tienen /proc, así que se muestrea el RSS actual con ps
// y el bucle de 100 ms aproxima el pico.
async function residentMiB(pid) {
  if (process.platform === 'linux') {
    const hwm = /VmHWM:\s+(\d+) kB/.exec(await readFile(`/proc/${pid}/status`, 'utf8').catch(() => ''))
    return hwm ? Number(hwm[1]) / 1024 : 0
  }
  try {
    return Number.parseInt(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }), 10) / 1024 || 0
  } catch {
    return 0
  }
}

assert.ok(process.env.DATABASE_URL, 'Configura DATABASE_URL para una base de prueba vacía')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
const query = async (sql, values) => (await client.query(sql, values)).rows
let checks = 0
const ok = message => console.log(`OK ${++checks}: ${message}`)
const rejects = async (label, operation, expected) => {
  await assert.rejects(operation, error => {
    const actual = error.code ?? error.reason ?? error.violations?.join(',')
    assert.equal(actual, expected, `${label}: ${actual}`)
    return true
  }, label)
  ok(`${label}: ${expected}`)
}

let clock = new Date('2026-09-28T12:00:00.000Z')
const now = () => new Date(clock)
const advance = ms => { clock = new Date(clock.getTime() + ms) }
const declaration = {
  description: 'Pack ficticio con fotos', category: 'Panadería', quantity: 4, conditions: null,
  address: 'Dirección ficticia 123', latitude: -33.45, longitude: -70.66, timeZone: 'America/Santiago',
  pickupStartsAt: new Date('2026-09-29T15:00:00.000Z'), pickupEndsAt: new Date('2026-09-29T18:00:00.000Z'),
}
const content = bytes => ({ readContent: async max => { assert.ok(bytes.length <= max); return new Uint8Array(bytes) } })
/** Lectura que queda abierta: simula un archivo todavía en tránsito. */
function heldContent(bytes) {
  let release
  const gate = new Promise(resolve => { release = resolve })
  return { input: { readContent: async () => { await gate; return new Uint8Array(bytes) } }, release: () => release() }
}

const storage = await mkdtemp(join(tmpdir(), 'rescate-k014-'))
const listObjects = async () => (await readdir(join(storage, 'lot-photos'), { recursive: true, withFileTypes: true }).catch(() => []))
  .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(storage.length + 'lot-photos/'.length + 1)).sort()
let pool
try {
  await client.connect()
  const [server] = await query("SELECT current_database() AS database, current_setting('server_version') AS version")
  assert.match(server.database, /^rescate_k014_test_[a-z0-9_]+$/, 'Usa una base dedicada rescate_k014_test_*')
  assert.deepEqual(await query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'`), [], 'La base debe estar vacía')
  execFileSync(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up'], { stdio: 'inherit', env: process.env })
  ok(`PostgreSQL ${server.version}; migraciones aplicadas en ${server.database}`)

  const users = await query(`INSERT INTO users(email) VALUES ('operador-k014@example.invalid'), ('ajeno-k014@example.invalid'),
    ('visitante-k014@example.invalid') RETURNING id::text`)
  const [operator, outsider, visitor] = users.map(row => ({ userId: row.id }))
  const establishments = await query(`INSERT INTO establishments(name, address, latitude, longitude, time_zone) VALUES
    ('Establecimiento K014', 'Dirección', -33.45, -70.66, 'America/Santiago'),
    ('Otro establecimiento K014', 'Otra', -33.46, -70.65, 'America/Santiago') RETURNING id::text, public_id::text`)
  await query('INSERT INTO memberships(user_id, establishment_id) VALUES ($1,$2),($3,$4)',
    [operator.userId, establishments[0].id, outsider.userId, establishments[1].id])

  pool = createPool({ connectionString: process.env.DATABASE_URL })
  let lots = createLotUseCases(createLotRepository(pool), now)
  const objects = createLocalObjectStore(storage)
  let photos = createPhotoUseCases({ repository: createPhotoRepository(pool), objects, images: createSharpImageProcessor(), now })
  const lot = await lots.createDraft(operator, { establishmentId: establishments[0].public_id, declaration })
  const second = await lots.createDraft(operator, { establishmentId: establishments[0].public_id, declaration })
  const jpeg = await jpegWithExif()
  ok('datos ficticios: operador, operador ajeno, visitante y dos borradores')

  // Autorización antes de aceptar bytes.
  let read = false
  const spy = { readContent: async () => { read = true; return new Uint8Array(jpeg) } }
  await rejects('carga de operador ajeno', photos.upload(outsider, { lotId: lot.publicId, ...spy }), 'not_authorized')
  await rejects('carga en lote inexistente', photos.upload(operator, { lotId: '00000000-0000-4000-8000-000000000000', ...spy }), 'lot_not_found')
  assert.equal(read, false)
  await rejects('listado de operador ajeno', photos.list(outsider, lot.publicId), 'not_authorized')
  assert.equal((await query('SELECT count(*)::int AS n FROM lot_photos'))[0].n, 0)
  ok('acceso ajeno: ni lee el archivo ni reserva una carga')

  // Archivos falsos o grandes no quedan guardados.
  await rejects('archivo falso con nombre de imagen', photos.upload(operator, { lotId: lot.publicId, ...content(fakePng()) }), 'unrecognized_image')
  const tooLarge = { readContent: async () => { throw Object.assign(new Error('demasiado grande'), { code: 'TOO_LARGE' }) } }
  await rejects('archivo que supera 5 MiB al leer', photos.upload(operator, { lotId: lot.publicId, ...tooLarge }), 'TOO_LARGE')
  assert.deepEqual(await query("SELECT status FROM lot_photos WHERE status <> 'removed'"), [])
  assert.deepEqual(await listObjects(), [])
  ok('archivo falso y archivo grande: cargas retiradas, sin objetos')

  // Carga válida; la publicación espera la validación (D-05).
  const first = await photos.upload(operator, { lotId: lot.publicId, ...content(jpeg) })
  assert.equal(first.status, 'pending')
  assert.equal(first.position, 1)
  assert.deepEqual(await listObjects(), [photoObjectKeys(first.publicId).upload])
  await rejects('publicar con foto pendiente', lots.publish(operator, { publicId: lot.publicId, expectedVersion: 1 }), 'photo_not_ready')

  // Máximo dos cargas simultáneas por operador, en cualquier lote.
  const heldA = heldContent(await pngOf(300, 200))
  const heldB = heldContent(await pngOf(300, 200))
  const uploadA = photos.upload(operator, { lotId: second.publicId, ...heldA.input })
  const uploadB = photos.upload(operator, { lotId: second.publicId, ...heldB.input })
  await new Promise(resolve => setTimeout(resolve, 200))
  await assert.rejects(photos.upload(operator, { lotId: lot.publicId, ...content(jpeg) }), error => {
    assert.equal(error.code, 'concurrent_photo_uploads')
    assert.ok(error.retryAfter >= 1 && error.retryAfter <= 300)
    return true
  })
  await rejects('publicar con carga en curso', lots.publish(operator, { publicId: second.publicId, expectedVersion: 1 }), 'photo_not_ready')
  heldA.release(); heldB.release()
  const [a, b] = await Promise.all([uploadA, uploadB])
  assert.deepEqual([a.position, b.position].sort(), [1, 2])
  ok('tercera carga simultánea rechazada con Retry-After; las dos vigentes se confirman')

  // Hasta tres fotos activas.
  const third = await photos.upload(operator, { lotId: second.publicId, ...content(await animatedWebp()) })
  await rejects('cuarta foto del lote', photos.upload(operator, { lotId: second.publicId, ...content(jpeg) }), 'photo_limit_reached')

  // Worker: valida, transforma, elimina EXIF y borra el original.
  assert.equal(await photos.processNext(), true)
  const [processed] = await query('SELECT status, format, width, height, attempts, upload_deleted_at IS NOT NULL AS upload_deleted FROM lot_photos WHERE public_id = $1', [first.publicId])
  assert.deepEqual(processed, { status: 'ready', format: 'jpeg', width: 1200, height: 1600, attempts: 1, upload_deleted: true })
  const keys = photoObjectKeys(first.publicId)
  assert.deepEqual(await listObjects(), [keys.display, keys.thumbnail, ...[a, b, third].map(p => photoObjectKeys(p.publicId).upload)].sort())
  const display = await objects.get(keys.display)
  const thumbnail = await objects.get(keys.thumbnail)
  assert.equal((await sharp(display).metadata()).exif, undefined)
  assert.ok(display.length <= 500 * 1024 && thumbnail.length <= 100 * 1024)
  assert.equal((await sharp(thumbnail).metadata()).height, 400)
  assert.equal(Buffer.from(display).includes('Dato privado de prueba'), false)
  ok('foto lista: WebP 1200×1600 y miniatura 300×400 sin EXIF; original temporal borrado')

  // Lectura: borrador solo para su operador.
  assert.deepEqual((await photos.read(operator, lot.publicId, first.publicId, 'thumbnail')).published, false)
  await rejects('visitante lee foto de borrador', photos.read(null, lot.publicId, first.publicId, 'display'), 'photo_not_found')
  await rejects('operador ajeno lee foto de borrador', photos.read(outsider, lot.publicId, first.publicId, 'display'), 'photo_not_found')
  await rejects('foto de otro lote', photos.read(operator, second.publicId, first.publicId, 'display'), 'photo_not_found')

  // Reinicio: una validación interrumpida se retoma al vencer el reclamo, sin duplicar.
  let repository = createPhotoRepository(pool)
  const claim = await repository.claimNextPending(now(), new Date(now().getTime() + PROCESSING_LEASE_MS))
  assert.equal(claim.attempts, 1)
  await pool.end()
  pool = createPool({ connectionString: process.env.DATABASE_URL })
  photos = createPhotoUseCases({ repository: createPhotoRepository(pool), objects, images: createSharpImageProcessor(), now })
  lots = createLotUseCases(createLotRepository(pool), now)
  repository = createPhotoRepository(pool)
  const order = (await query("SELECT public_id::text FROM lot_photos WHERE status = 'pending' ORDER BY created_at, id")).map(r => r.public_id)
  assert.equal(order[0], claim.publicId)
  // Mientras el reclamo sigue vigente, otro worker toma la siguiente foto y no esta.
  assert.equal(await photos.processNext(), true)
  assert.equal((await query('SELECT status FROM lot_photos WHERE public_id = $1', [claim.publicId]))[0].status, 'pending')
  advance(PROCESSING_LEASE_MS + 1)
  while (await photos.processNext()) { /* procesa el resto */ }
  const results = await query(`SELECT public_id::text, status, rejection_reason, attempts FROM lot_photos
    WHERE lot_id = (SELECT id FROM lots WHERE public_id = $1) ORDER BY position`, [second.publicId])
  const resumed = results.find(row => row.public_id === claim.publicId)
  assert.equal(resumed.status, 'ready')
  assert.equal(resumed.attempts, 2)
  assert.deepEqual(results.find(row => row.public_id === third.publicId), { public_id: third.publicId, status: 'rejected', rejection_reason: 'animated', attempts: 1 })
  const resumedKeys = photoObjectKeys(claim.publicId)
  assert.equal((await listObjects()).filter(key => key.includes(claim.publicId)).join(), [resumedKeys.display, resumedKeys.thumbnail].join())
  assert.equal((await query('SELECT count(*)::int AS n FROM lot_photos WHERE public_id = $1', [claim.publicId]))[0].n, 1)
  ok('reinicio con nuevo Pool: reclamo vencido retomado una vez; mismo registro y solo dos salidas')
  ok('WebP animado rechazado por el worker con motivo animated')

  // Una foto rechazada impide publicar hasta quitarla; quitar borra sus objetos.
  await rejects('publicar con foto rechazada', lots.publish(operator, { publicId: second.publicId, expectedVersion: 1 }), 'photo_not_ready')
  await rejects('operador ajeno quita foto', photos.remove(outsider, second.publicId, third.publicId), 'not_authorized')
  await photos.remove(operator, second.publicId, third.publicId)
  assert.equal((await listObjects()).some(key => key.includes(third.publicId)), false)
  assert.deepEqual((await query('SELECT status, objects_deleted_at IS NOT NULL AS cleaned FROM lot_photos WHERE public_id = $1', [third.publicId]))[0],
    { status: 'removed', cleaned: true })
  const published = await lots.publish(operator, { publicId: second.publicId, expectedVersion: 1 })
  assert.equal(published.status, 'published')
  ok('foto rechazada quitada: objetos borrados y publicación con dos fotos listas')

  // Publicado: fotos fijas y visibles sin sesión.
  await rejects('cargar en publicado', photos.upload(operator, { lotId: second.publicId, ...content(jpeg) }), 'photo_not_draft')
  await rejects('quitar en publicado', photos.remove(operator, second.publicId, a.publicId), 'photo_not_draft')
  const publicPhoto = await photos.read(null, second.publicId, a.publicId, 'display')
  assert.equal(publicPhoto.published, true)
  assert.equal((await sharp(publicPhoto.bytes).metadata()).format, 'webp')
  const discovery = createDiscoveryUseCases(createDiscoveryRepository(pool), createPickupCodes(randomBytes(32)), now)
  const detail = await discovery.get(second.publicId)
  const [cover] = await query(`SELECT public_id::text FROM lot_photos WHERE status = 'ready'
    AND lot_id = (SELECT id FROM lots WHERE public_id = $1) ORDER BY position LIMIT 1`, [second.publicId])
  assert.equal(detail.photoId, cover.public_id)
  const readyPhotos = await query(`SELECT public_id::text AS id, width, height FROM lot_photos WHERE status = 'ready'
    AND lot_id = (SELECT id FROM lots WHERE public_id = $1) ORDER BY position`, [second.publicId])
  assert.equal(readyPhotos.length, 2)
  assert.deepEqual(detail.photos, readyPhotos)
  const search = await discovery.search({ page: 1 })
  assert.equal(search.items.find(item => item.id === second.publicId).photoId, detail.photoId)
  ok('publicado: sin cargas ni retiros; imagen pública, primera foto en búsqueda y detalle, y las dos fotos listas en orden')

  // Carga abandonada: vence a los 5 minutos y la limpieza la borra.
  const abandoned = heldContent(jpeg)
  const pendingUpload = photos.upload(operator, { lotId: lot.publicId, ...abandoned.input })
  await new Promise(resolve => setTimeout(resolve, 200))
  const [slot] = await query("SELECT public_id::text FROM lot_photos WHERE status = 'uploading'")
  advance(5 * 60 * 1000 + 61 * 1000)
  assert.ok(await photos.cleanup() >= 1)
  assert.equal((await query('SELECT status FROM lot_photos WHERE public_id = $1', [slot.public_id]))[0].status, 'removed')
  abandoned.release()
  await assert.rejects(pendingUpload, error => error.code === 'photo_upload_expired')
  assert.equal((await listObjects()).some(key => key.includes(slot.public_id)), false)
  ok('carga vencida: retirada por la limpieza; su confirmación tardía falla y no deja objetos')

  // Validación que falla repetidamente: se rechaza tras tres intentos.
  const stubborn = await photos.upload(operator, { lotId: lot.publicId, ...content(await pngOf(50, 50)) })
  for (let attempt = 1; attempt <= 3; attempt++) {
    await repository.claimNextPending(now(), new Date(now().getTime() + PROCESSING_LEASE_MS))
    advance(PROCESSING_LEASE_MS + 1)
  }
  assert.equal(await photos.processNext(), true)
  assert.deepEqual((await query('SELECT status, rejection_reason, attempts FROM lot_photos WHERE public_id = $1', [stubborn.publicId]))[0],
    { status: 'rejected', rejection_reason: 'processing_failed', attempts: 4 })
  ok('validación interrumpida tres veces: rechazada con processing_failed, sin reintentos infinitos')

  // Quitar durante la validación: el worker no deja salidas huérfanas.
  await photos.remove(operator, lot.publicId, stubborn.publicId)
  const racing = await photos.upload(operator, { lotId: lot.publicId, ...content(await pngOf(640, 480)) })
  const slow = createPhotoUseCases({ repository: createPhotoRepository(pool), objects, now, images: {
    ...createSharpImageProcessor(),
    async inspect(bytes) {
      await photos.remove(operator, lot.publicId, racing.publicId)
      return createSharpImageProcessor().inspect(bytes)
    },
  } })
  assert.equal(await slow.processNext(), true)
  assert.equal((await query('SELECT status FROM lot_photos WHERE public_id = $1', [racing.publicId]))[0].status, 'removed')
  await photos.cleanup()
  assert.equal((await listObjects()).some(key => key.includes(racing.publicId)), false)
  ok('foto quitada durante la validación: sin imagen ni miniatura huérfanas')

  // HTTP real: sesión K008, Origin/CSRF, cuerpo binario y respuestas contra OpenAPI.
  const origin = 'https://localhost:3443'
  const api = createApi({ DATABASE_URL: process.env.DATABASE_URL, RESCATE_ALLOWED_ORIGINS: origin,
    CSRF_SIGNING_KEY: randomBytes(32).toString('base64'), PICKUP_CODE_KEY: randomBytes(32).toString('base64'),
    PHOTO_STORAGE: 'local', PHOTO_LOCAL_DIR: storage })
  const httpServer = api.app.listen(0, '127.0.0.1')
  await once(httpServer, 'listening')
  const base = `http://127.0.0.1:${httpServer.address().port}`
  const jar = new Map()
  let csrf = ''
  const call = async (method, path, { body, type, cookies = true, json = true } = {}) => {
    const headers = { ...(cookies ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      ...(method === 'GET' ? {} : { origin, 'x-csrf-token': csrf }), ...(type ? { 'content-type': type } : {}) }
    const response = await fetch(base + path, { method, headers,
      body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body })
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'); const at = pair.indexOf('=')
      jar.set(pair.slice(0, at), pair.slice(at + 1))
    }
    const image = response.headers.get('content-type')?.startsWith('image/')
    const parsed = image ? new Uint8Array(await response.arrayBuffer()) : response.status === 204 ? undefined : await response.json()
    if (parsed?.csrfToken) csrf = parsed.csrfToken
    if (json && !image) assertContract(method, path, response, parsed)
    return { status: response.status, headers: response.headers, body: parsed }
  }
  try {
    await call('GET', '/auth/session')
    const credentials = { email: 'operador-http-k014@example.invalid', password: 'Contraseña ficticia K014 segura' }
    assert.equal((await call('POST', '/auth/register', { body: credentials, type: 'application/json' })).status, 201)
    const [registered] = await query('SELECT id::text FROM users WHERE email = $1', [credentials.email])
    await query('INSERT INTO memberships(user_id, establishment_id) VALUES ($1, $2)', [registered.id, establishments[0].id])
    assert.equal((await call('POST', '/auth/login', { body: credentials, type: 'application/json' })).status, 200)
    const created = await call('POST', `/establishments/${establishments[0].public_id}/lots`, { type: 'application/json', body: {
      ...declaration, pickupStartsAt: '2030-01-15T18:00:00Z', pickupEndsAt: '2030-01-15T21:00:00Z' } })
    assert.equal(created.status, 201)
    const lotId = created.body.id
    const photosPath = `/lots/${lotId}/photos`

    assert.equal((await call('POST', photosPath, { body: svg(), type: 'image/svg+xml' })).status, 415)
    assert.equal((await call('POST', photosPath, { body: fakePng(), type: 'image/png' })).status, 422)
    const oversized = new Uint8Array(5 * 1024 * 1024 + 1); oversized.set(jpeg.subarray(0, 3))
    assert.equal((await call('POST', photosPath, { body: oversized, type: 'image/jpeg' })).status, 413)
    const csrfBefore = csrf; csrf = 'invalido'
    assert.equal((await call('POST', photosPath, { body: jpeg, type: 'image/jpeg' })).status, 403)
    csrf = csrfBefore
    assert.equal((await call('POST', photosPath, { body: jpeg, type: 'image/jpeg', cookies: false })).status, 401)
    const accepted = await call('POST', photosPath, { body: jpeg, type: 'image/jpeg' })
    assert.equal(accepted.status, 202)
    assert.equal(accepted.body.status, 'pending')
    ok('HTTP: 415 SVG, 422 firma falsa, 413 sobre 5 MiB, 403 sin CSRF, 401 sin sesión y 202 válido según OpenAPI')

    assert.equal((await call('POST', `/lots/${lotId}/publish`, { body: { version: 1 }, type: 'application/json' })).status, 422)
    const worker = createPhotoUseCases({ repository: createPhotoRepository(pool), objects, images: createSharpImageProcessor(), now: () => new Date() })
    assert.equal(await worker.processNext(), true)
    const listed = await call('GET', photosPath)
    assert.equal(listed.body.items[0].status, 'ready')
    const { thumbnailUrl, displayUrl } = listed.body.items[0]
    assert.equal((await call('GET', thumbnailUrl, { cookies: false })).status, 404)
    const privateImage = await call('GET', thumbnailUrl)
    assert.equal(privateImage.status, 200)
    assert.equal(privateImage.headers.get('cache-control'), 'no-store')
    assert.equal((await sharp(privateImage.body).metadata()).format, 'webp')
    assert.equal((await call('POST', `/lots/${lotId}/publish`, { body: { version: 1 }, type: 'application/json' })).status, 200)
    const publicDetail = await call('GET', `/public/lots/${lotId}`, { cookies: false })
    assert.equal(publicDetail.body.photoUrl, displayUrl)
    assert.deepEqual(publicDetail.body.photos.map(photo => [photo.thumbnailUrl, photo.displayUrl]), [[thumbnailUrl, displayUrl]])
    const publicImage = await call('GET', publicDetail.body.photoUrl, { cookies: false })
    assert.equal(publicImage.status, 200)
    assert.equal(publicImage.headers.get('cache-control'), 'private, max-age=3600')
    assert.equal((await sharp(publicImage.body).metadata()).exif, undefined)
    assert.equal((await call('DELETE', `${photosPath}/${listed.body.items[0].id}`)).status, 409)
    ok('HTTP: 422 al publicar en validación; borrador privado; publicado visible sin sesión desde photoUrl y fijo (409)')
  } finally {
    await new Promise(resolve => httpServer.close(resolve))
    await api.close()
  }

  // Proceso real del worker con el archivo límite: 20 MP y casi 5 MiB.
  const limit = await limitJpeg()
  const heavy = await photos.upload(operator, { lotId: lot.publicId, ...content(limit) })
  const worker = spawn(process.execPath, ['dist/worker.js'], {
    env: { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, PHOTO_STORAGE: 'local', PHOTO_LOCAL_DIR: storage },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let output = ''
  worker.stdout.on('data', chunk => { output += chunk })
  let status = 'pending'
  let peak = 0
  const deadline = Date.now() + 60_000
  while (status === 'pending' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    peak = Math.max(peak, await residentMiB(worker.pid))
    status = (await query('SELECT status FROM lot_photos WHERE public_id = $1', [heavy.publicId]))[0].status
  }
  worker.kill('SIGTERM')
  const [code] = await once(worker, 'exit')
  assert.equal(status, 'ready')
  assert.equal(code, 0, 'SIGTERM termina el worker de forma ordenada')
  assert.match(output, /Worker iniciado: validación y limpieza de fotos/)
  assert.doesNotMatch(output, /postgresql:|PHOTO_|photo_worker_error/)
  assert.ok(peak > 0 && peak < 768, `memoria máxima del worker: ${peak.toFixed(1)} MiB`)
  const [heavyRow] = await query('SELECT width, height, source_bytes FROM lot_photos WHERE public_id = $1', [heavy.publicId])
  assert.equal(Math.max(heavyRow.width, heavyRow.height), 1600)
  assert.ok((await objects.get(photoObjectKeys(heavy.publicId).display)).length <= 500 * 1024)
  ok(`worker real: archivo límite de ${(limit.length / 1048576).toFixed(2)} MiB y 20 MP listo; pico RSS ${peak.toFixed(0)} MiB; SIGTERM ordenado`)

  // Toda clave que queda pertenece a una foto lista y visible.
  const ready = (await query("SELECT public_id::text FROM lot_photos WHERE status = 'ready' ORDER BY public_id")).map(row => row.public_id)
  assert.deepEqual(await listObjects(), ready.flatMap(id => [photoObjectKeys(id).display, photoObjectKeys(id).thumbnail]).sort())
  assert.deepEqual(await query(`SELECT public_id FROM lot_photos WHERE status IN ('ready','rejected') AND upload_deleted_at IS NULL
    UNION ALL SELECT public_id FROM lot_photos WHERE status = 'removed' AND objects_deleted_at IS NULL`), [])
  ok('inventario final: solo salidas de fotos listas; ningún temporal ni objeto de foto quitada')
  console.log(`PASS K014: ${checks} comprobaciones; base conservada para inspección`)
} finally {
  await pool?.end().catch(() => {})
  await client.end()
  await rm(storage, { recursive: true, force: true })
}
