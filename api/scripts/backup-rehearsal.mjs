// K053 · Ensayo local de punta a punta (RNF08, anexos I p. 27). Siembra una fuente aislada
// rescate_k053_source_*, creada desde template_postgis con las mismas extensiones que la base
// de producción (10_postgis.sh de la imagen), con los casos de uso reales (lotes con fotos, reservas con código,
// entregas, cola con oferta, chat, incidencias con avisos, cierre por incidencia y lote
// vencido), copia, simula la pérdida borrando la fuente y sus fotos, restaura en una base
// nueva, concilia, levanta la API actual y la del release anterior y mide. Después ensaya
// fallas: la conciliación debe detectar cada referencia rota. No toca la base de desarrollo.
// Uso: npm --prefix api run backup:rehearsal [-- --rondas N] [--anterior <commit o tag>] [--conservar]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import pg from 'pg'
import sharp from 'sharp'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createPickupCodes } from '../dist/infrastructure/crypto/pickup-codes.js'
import { createLocalObjectStore } from '../dist/infrastructure/objects/local-object-store.js'
import { createSharpImageProcessor } from '../dist/infrastructure/images/sharp-image-processor.js'
import { createLotRepository } from '../dist/infrastructure/postgres/lot-repository.js'
import { createLotUseCases } from '../dist/application/lots/use-cases.js'
import { createPhotoRepository } from '../dist/infrastructure/postgres/photo-repository.js'
import { createPhotoUseCases } from '../dist/application/photos/use-cases.js'
import { createDiscoveryRepository } from '../dist/infrastructure/postgres/discovery-repository.js'
import { createDiscoveryUseCases } from '../dist/application/discovery/use-cases.js'
import { createReservationRepository } from '../dist/infrastructure/postgres/reservation-repository.js'
import { createReservationUseCases } from '../dist/application/reservations/use-cases.js'
import { createWaitlistRepository } from '../dist/infrastructure/postgres/waitlist-repository.js'
import { createWaitlistUseCases } from '../dist/application/waitlist/use-cases.js'
import { createChatRepository } from '../dist/infrastructure/postgres/chat-repository.js'
import { createChatUseCases } from '../dist/application/chat/use-cases.js'
import { createIncidentDispatchRepository, createIncidentRepository } from '../dist/infrastructure/postgres/incident-repository.js'
import { createIncidentDispatcher, createIncidentUseCases } from '../dist/application/incidents/use-cases.js'
import { createOutboxRepository } from '../dist/infrastructure/postgres/notification-repository.js'
import { createOutboxProcessor } from '../dist/application/notifications/use-cases.js'
import { createLotExpiryRepository } from '../dist/infrastructure/postgres/expiry-repository.js'
import { createExpiryUseCases } from '../dist/application/expiries/use-cases.js'
import { apiDirectory, composeDatabase, createBackup, localObjects, onInterrupt, remoteDatabase, repositoryState, resultsDirectory, timer } from './support/backup.mjs'
import { reconcile } from './support/reconcile.mjs'
import { defaultPreviousRelease } from './support/release-check.mjs'
import { printRecovery, restoreAndVerify } from './support/restore.mjs'

const { values: options } = parseArgs({ options: {
  rondas: { type: 'string', default: '3' },
  // Por omisión, el release anterior al vigente (docs/despliegue.md#comprobación-y-recuperación).
  anterior: { type: 'string' },
  conservar: { type: 'boolean', default: false },
} })
const rounds = Number(options.rondas)
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 500, '--rondas admite enteros entre 1 y 500')
const previousRelease = options.anterior ?? defaultPreviousRelease()
assert.ok(previousRelease, 'No hay dos etiquetas deploy-* alcanzables desde HEAD: indicar --anterior')

const minutes = n => n * 60_000
/** Imagen JPEG distinta por foto: el worker la convierte a WebP con miniatura. */
const jpeg = (seed) => sharp({ create: { width: 900, height: 600, channels: 3,
  background: { r: (seed * 53) % 256, g: (seed * 97) % 256, b: (seed * 151) % 256 } } }).jpeg({ quality: 80 }).toBuffer()

/** Datos realistas con los casos de uso; `round` repite el escenario con personas nuevas. */
async function seed(databaseUrl, photoDirectory, pickupKey) {
  const pool = createPool({ connectionString: databaseUrl })
  const query = async (sql, values) => (await pool.query(sql, values)).rows
  const now = () => new Date()
  const codes = createPickupCodes(pickupKey)
  const lots = createLotUseCases(createLotRepository(pool), now)
  const photos = createPhotoUseCases({ repository: createPhotoRepository(pool), objects: createLocalObjectStore(photoDirectory),
    images: createSharpImageProcessor(), now })
  const discovery = createDiscoveryUseCases(createDiscoveryRepository(pool), codes, now)
  const reservations = createReservationUseCases(createReservationRepository(pool), codes, now)
  const waitlist = createWaitlistUseCases(createWaitlistRepository(pool), codes, now)
  const chat = createChatUseCases(createChatRepository(pool), now)
  const incidents = createIncidentUseCases(createIncidentRepository(pool))
  const dispatcher = createIncidentDispatcher(createIncidentDispatchRepository(pool))
  const outbox = createOutboxProcessor(createOutboxRepository(pool), now)
  const expiries = createExpiryUseCases(createLotExpiryRepository(pool), () => {})
  const person = async label => ({ userId: (await query('INSERT INTO users(email) VALUES ($1) RETURNING id::text',
    [`k053-${label}-${randomUUID()}@example.invalid`]))[0].id })
  const reserve = async (actor, lot, quantity = 1) => discovery.reserve(actor, lot, quantity, randomUUID())
  const deliver = async (operator, lot, holder, reservation) => reservations.confirmPickup(operator, lot, reservation.id,
    (await reservations.get(holder, reservation.id)).pickupCode, randomUUID(), () => {})
  const incidentCommand = (action, version, extra = {}) => ({ action, version, reason: 'Envase dañado en parte del lote',
    instructions: 'Revisar el pack antes de consumir; el establecimiento repone si corresponde', idempotencyKey: randomUUID(), ...extra })

  const operator = await person('operador')
  const [establishment] = await query(`INSERT INTO establishments(name, address, latitude, longitude, time_zone)
    VALUES ('Panadería de ensayo K053', 'Dirección ficticia 123, Santiago', -33.45, -70.66, 'America/Santiago')
    RETURNING id::text, public_id::text`)
  await query('INSERT INTO memberships(user_id, establishment_id) VALUES ($1, $2)', [operator.userId, establishment.id])
  const sqlLot = async (description, quantity) => (await query(`INSERT INTO lots(establishment_id, description, category, quantity,
      address, latitude, longitude, time_zone, pickup_starts_at, pickup_ends_at, status, published_at)
    VALUES ($1, $2, 'Panadería', $3, 'Dirección ficticia 123, Santiago', -33.45, -70.66, 'America/Santiago',
      now() - interval '1 hour', now() + interval '3 hours', 'published', now() - interval '2 hours') RETURNING public_id::text AS id`,
  [establishment.id, description, quantity]))[0].id

  let photoSeed = 0
  try {
    for (let round = 1; round <= rounds; round++) {
      const [p1, p2, p3, p4, p5, p6] = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(label => person(`${label}${round}`)))

      // A · publicado por el formulario: dos fotos listas y una quitada después de validarse.
      const draft = await lots.createDraft(operator, { establishmentId: establishment.public_id, description: {
        description: `Pack de pan del día ${round}: marraquetas y hallullas`, category: 'Panadería', quantity: 5,
        conditions: 'Trae tu bolsa reutilizable.', address: 'Dirección ficticia 123, Santiago', latitude: -33.45, longitude: -70.66,
        timeZone: 'America/Santiago', pickupStartsAt: new Date(Date.now() - minutes(60)), pickupEndsAt: new Date(Date.now() + minutes(180)) } })
      const uploaded = []
      for (let index = 0; index < 3; index++) {
        const bytes = await jpeg(++photoSeed)
        uploaded.push(await photos.upload(operator, { lotId: draft.publicId, readContent: async () => new Uint8Array(bytes) }))
      }
      while (await photos.processNext()) { /* valida y genera imagen y miniatura */ }
      await photos.remove(operator, draft.publicId, uploaded[2].publicId)
      await photos.cleanup()
      const [{ version }] = await query('SELECT version FROM lots WHERE public_id = $1', [draft.publicId])
      const lotA = (await lots.publish(operator, { publicId: draft.publicId, expectedVersion: version })).publicId
      const r1 = await reserve(p1, lotA)
      await chat.send(p1, r1.id, '¿Hasta qué hora puedo pasar a retirar?', randomUUID())
      await deliver(operator, lotA, p2, await reserve(p2, lotA))
      await reservations.cancel(p3, (await reserve(p3, lotA)).id)

      // B · sin packs libres, cola con oferta parcial e incidencia con seguimiento.
      const lotB = await sqlLot(`Pack de verduras ${round}: zapallo y acelga`, 3)
      await reserve(p4, lotB, 2)
      const r6 = await reserve(p6, lotB)
      await waitlist.join(p5, lotB, 2, randomUUID())
      await reservations.cancel(p6, r6.id)
      const incidentB = await incidents.report(p4, lotB, { reason: 'Parte del pack llegó en mal estado', idempotencyKey: randomUUID() })
      await incidents.command(operator, incidentB.id, incidentCommand('publish', 0))
      await incidents.command(operator, incidentB.id, incidentCommand('update', 1))

      // C · cierre por incidencia: conserva la entrega y vence lo demás.
      const lotC = await sqlLot(`Pack de pastelería ${round}`, 3)
      await deliver(operator, lotC, p1, await reserve(p1, lotC))
      await reserve(p2, lotC)
      const incidentC = await incidents.report(p2, lotC, { reason: 'Etiqueta con fecha incorrecta', idempotencyKey: randomUUID() })
      await incidents.command(operator, incidentC.id, incidentCommand('publish', 0, { closeLot: true }))

      // D · vencido al cierre con una entrega y una reserva sin retirar.
      const lotD = await sqlLot(`Pack de lácteos ${round}`, 3)
      await deliver(operator, lotD, p3, await reserve(p3, lotD))
      await reserve(p4, lotD)
      await query(`UPDATE lots SET pickup_starts_at = now() - interval '3 hours', pickup_ends_at = now() - interval '1 minute'
        WHERE public_id = $1`, [lotD])
      while (await expiries.expireNext()) { /* registra el cierre */ }
    }
    while (await dispatcher.processNext()) { /* destinatarios a eventos */ }
    while (await outbox.processNext()) { /* eventos a avisos */ }
  } finally {
    await pool.end()
  }
}

/** Corre la conciliación y devuelve los nombres de las comprobaciones que fallaron. */
async function failedChecks(db, database, manifest, photoRoot, pickupKey) {
  const client = new pg.Client({ connectionString: db.url(database) })
  await client.connect()
  try {
    const failures = (await reconcile({ client, manifest, objects: localObjects(photoRoot), pickupKey })).checks.filter(item => !item.ok)
    for (const item of failures) console.log(`     detectado · ${item.name}: ${item.sample.join('; ')}`)
    return failures.map(item => item.name)
  } finally {
    await client.end()
  }
}

const db = composeDatabase()
const { commit, dirty } = repositoryState()
const startedAt = new Date()
const directory = join(resultsDirectory, `${startedAt.toISOString().replace(/[:.]/g, '-')}-${commit.slice(0, 7)}-ensayo`)
const databases = []
// Ctrl-C también borra las bases, salvo con --conservar.
const track = database => {
  databases.push(database)
  if (!options.conservar) onInterrupt(() => { if (databases.includes(database)) db.drop(database) })
  console.log(`  base ${database}`)
}
// K053_PICKUP_CODE_KEY opcional permite repetir backup:restore sobre las bases conservadas.
const pickupKey = process.env.K053_PICKUP_CODE_KEY ? Buffer.from(process.env.K053_PICKUP_CODE_KEY, 'base64') : randomBytes(32)
assert.ok(pickupKey.length >= 32, 'K053_PICKUP_CODE_KEY requiere 32 bytes en base64')
const report = { card: 'K053', kind: 'ensayo local', startedAt: startedAt.toISOString(), commit, dirty, node: process.version, rounds, previousRelease }
const clock = timer()
let failed = false
try {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  console.log(`Ensayo K053 en ${directory}`)
  const source = db.create('source', 'template_postgis')
  track(source)
  const sourceUrl = db.url(source)
  const sourceConnection = await remoteDatabase(sourceUrl, 'fuente del ensayo')
  const sourcePhotos = join(directory, 'fuente-fotos')
  console.log(`\n1. Fuente aislada ${source} con ${rounds} ronda(s) de datos`)
  await clock.run('migrar la fuente', async () => execFileSync(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up'],
    { cwd: apiDirectory, stdio: 'ignore', env: { ...process.env, DATABASE_URL: sourceUrl } }))
  await clock.run('sembrar la fuente', () => seed(sourceUrl, sourcePhotos, pickupKey))

  console.log('\n2. Copia')
  const backup = join(directory, 'copia')
  const manifest = await clock.run('copia completa', () => createBackup({ source: sourceConnection, objects: createLocalObjectStore(sourcePhotos), storage: 'local', directory: backup }))
  report.backup = { directory: backup, steps: manifest.durations.steps, totalMs: manifest.durations.totalMs, dumpBytes: manifest.database.bytes,
    objects: manifest.photos.objects.length, readyPhotos: manifest.photos.readyPhotos, counts: manifest.counts, aggregates: manifest.aggregates,
    source: manifest.source }
  console.log(`  ${manifest.database.bytes} bytes de volcado, ${manifest.photos.objects.length} objetos de ${manifest.photos.readyPhotos} fotos listas`)
  assert.equal(manifest.photos.missing.length, 0, 'La fuente sembrada no debía tener faltantes')

  console.log('\n3. Falla en la fuente: una foto lista sin su miniatura')
  const lost = manifest.photos.objects.find(object => object.key.endsWith('thumbnail.webp'))
  await rm(join(sourcePhotos, 'lot-photos', lost.key))
  const second = await createBackup({ source: sourceConnection, objects: createLocalObjectStore(sourcePhotos), storage: 'local', directory: join(directory, 'copia-con-faltante') })
  const detected = second.photos.missing.map(item => item.key)
  report.sourceMissing = { removed: lost.key, detected, ok: detected.length === 1 && detected[0] === lost.key }
  console.log(`${report.sourceMissing.ok ? 'OK  ' : 'FAIL'} el manifiesto registra la referencia faltante ${detected.join(', ')}`)

  console.log('\n4. Pérdida simulada: se borran la fuente y sus fotos')
  db.drop(source)
  databases.splice(databases.indexOf(source), 1)
  await rm(sourcePhotos, { recursive: true, force: true })

  console.log('\n5. Restauración desde la copia')
  const intervention = performance.now()
  const restored = await restoreAndVerify({ directory: backup, pickupKey, previousRelease, interventionStarted: intervention, db,
    onDatabase: track })
  printRecovery(restored)
  report.restore = restored

  console.log('\n6. Ensayo de fallas sobre lo restaurado')
  const drills = []
  const drill = async (name, expected, act, undo = async () => {}) => {
    const target = await act()
    const failures = await failedChecks(db, target.database, manifest, restored.photoRoot, target.key ?? pickupKey)
    await undo(target)
    const ok = expected.every(item => failures.includes(item))
    drills.push({ name, expected, detected: failures, ok })
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: detecta ${expected.join(' + ')}`)
  }
  const objectPath = key => join(restored.photoRoot, 'lot-photos', key)
  const backupPath = key => join(backup, 'objects', 'lot-photos', key)
  const display = manifest.photos.objects.find(object => object.key.endsWith('display.webp')).key
  await drill('objeto restaurado borrado', ['fotos listas con sus objetos'],
    async () => { await rm(objectPath(display)); return { database: restored.database } },
    async () => copyFile(backupPath(display), objectPath(display)))
  await drill('objeto restaurado alterado', ['fotos listas con sus objetos'],
    async () => { await writeFile(objectPath(display), Buffer.from('alterado')); return { database: restored.database } },
    async () => copyFile(backupPath(display), objectPath(display)))
  await drill('PICKUP_CODE_KEY distinta', ['códigos de retiro'], async () => ({ database: restored.database, key: randomBytes(32) }))

  const broken = db.clone(restored.database, 'faults')
  track(broken)
  const client = new pg.Client({ connectionString: db.url(broken) })
  await client.connect()
  try {
    const one = async sql => (await client.query(sql)).rows[0]
    await one(`DELETE FROM deliveries WHERE id = (SELECT min(id) FROM deliveries) RETURNING id`)
    await one(`UPDATE commitments SET pickup_code_ciphertext = decode(repeat('01', length(pickup_code_ciphertext)), 'hex')
      WHERE id = (SELECT min(id) FROM commitments WHERE status = 'confirmed') RETURNING id`)
    await one(`UPDATE incidents SET version = version + 1 WHERE id = (SELECT min(id) FROM incidents WHERE status = 'open') RETURNING id`)
    await one(`UPDATE lot_photos SET status = 'ready', removed_at = NULL WHERE id = (SELECT min(id) FROM lot_photos WHERE status = 'removed') RETURNING id`)
    await one(`UPDATE chat_messages SET sequence = sequence + 1 WHERE id = (SELECT min(id) FROM chat_messages) RETURNING id`)
    await one(`INSERT INTO pgmigrations(name, run_on) VALUES ('1799999999999_desconocida', now()) RETURNING id`)
    await one(`ALTER TABLE lots DROP CONSTRAINT lots_inventory_total_check`)
    await one(`SELECT setval(pg_get_serial_sequence('public.deliveries', 'id'), 1, false)`)
    await one(`UPDATE incident_recipients SET outbox_event_id = NULL
      WHERE ctid = (SELECT ctid FROM incident_recipients WHERE outbox_event_id IS NOT NULL LIMIT 1) RETURNING version`)
  } finally {
    await client.end()
  }
  await drill('filas y esquema rotos en una copia de la base', ['migraciones iguales al repositorio', 'conteos y agregados iguales al manifiesto',
    'esquema igual al manifiesto', 'secuencias de identificadores',
    'inventario de lotes (Q = F + O + R + E + X; R, O, E con sus registros; lote cerrado sin F, O, R ni cola)',
    'una entrega por compromiso entregado', 'códigos de retiro', 'incidencias y sus versiones', 'destinatarios con su evento de aviso',
    'mensajes del chat en secuencia', 'fotos listas con sus objetos'],
  async () => ({ database: broken }))
  report.drills = drills

  // Después de deshacer los cambios de archivos, lo restaurado vuelve a conciliar.
  report.reconciledAfterDrills = (await failedChecks(db, restored.database, manifest, restored.photoRoot, pickupKey)).length === 0
  console.log(`${report.reconciledAfterDrills ? 'OK  ' : 'FAIL'} lo restaurado concilia de nuevo tras deshacer las fallas de archivos`)

  failed = !restored.passed || !report.sourceMissing.ok || drills.some(item => !item.ok) || !report.reconciledAfterDrills
} catch (error) {
  failed = true
  report.error = String(error?.message ?? error).split('\n')[0].replace(/postgres(ql)?:\/\/\S+/g, '<url>')
  console.error(`FAIL K053 ensayo: ${report.error}`)
} finally {
  report.steps = clock.steps
  report.finishedAt = new Date().toISOString()
  report.totalMs = Date.now() - startedAt.getTime()
  report.passed = !failed
  if (!options.conservar) {
    for (const database of databases) { try { db.drop(database) } catch { report.cleanup = 'Alguna base K053 no se pudo borrar' } }
  }
  report.databases = options.conservar ? databases : []
  await writeFile(join(directory, 'rehearsal.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(() => {})
  console.log(`\n${report.passed ? 'PASS' : 'FAIL'} K053 ensayo de copia y restauración. Resultados en ${directory}`)
  if (options.conservar) console.log(`Bases conservadas: ${databases.join(', ')}`)
  process.exitCode = report.passed ? 0 : 1
}
