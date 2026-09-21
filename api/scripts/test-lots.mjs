// K010 · Integración real con PostgreSQL: repositorio, transacciones y reglas.
// Destructiva solo en una base dedicada rescate_k010_test_*, creada vacía.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import pg from 'pg'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createLotRepository } from '../dist/infrastructure/postgres/lot-repository.js'
import { createLotUseCases } from '../dist/application/lots/use-cases.js'

assert.ok(process.env.DATABASE_URL, 'Configura DATABASE_URL para una base de prueba vacía')

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
const pool = createPool({ connectionString: process.env.DATABASE_URL })
const run = (direction, ...args) => execFileSync(process.execPath, [
  'node_modules/node-pg-migrate/bin/node-pg-migrate.js', direction, ...args,
], { stdio: 'inherit', env: process.env })

const query = async (sql, values) => (await client.query(sql, values)).rows
let checks = 0
const ok = (message) => console.log(`OK ${++checks}: ${message}`)

const NOW = new Date('2026-09-21T12:00:00.000Z')
const declaration = (overrides = {}) => ({
  description: 'Pack ficticio de verduras',
  category: 'Verduras',
  quantity: 3,
  conditions: null,
  address: 'Dirección ficticia 123',
  latitude: -33.45,
  longitude: -70.66,
  timeZone: 'America/Santiago',
  pickupStartsAt: new Date('2026-10-01T15:00:00.000Z'),
  pickupEndsAt: new Date('2026-10-01T17:00:00.000Z'),
  ...overrides,
})

const failsWith = async (label, operation, expected) => {
  await assert.rejects(operation, (error) => {
    const actual = error.code ?? error.violations?.join(',')
    assert.equal(actual, expected, `${label}: ${actual}`)
    return true
  }, label)
  ok(`${label}: rechazado con ${expected}`)
}

try {
  await client.connect()
  const [server] = await query("SELECT current_database() AS database, current_setting('server_version') AS version")
  assert.match(server.database, /^rescate_k010_test_[a-z0-9_]+$/, 'Usa una base dedicada rescate_k010_test_*')
  const existing = await query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','S','f')`)
  assert.deepEqual(existing, [], 'La base debe estar vacía')
  ok(`PostgreSQL ${server.version}; base ${server.database} vacía`)

  run('up')
  const columns = await query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema='public' AND table_name='lots' AND column_name = ANY($1) ORDER BY column_name`,
    [['public_id', 'version', 'updated_at']])
  assert.deepEqual(columns.map(c => [c.column_name, c.data_type, c.is_nullable]), [
    ['public_id', 'uuid', 'NO'], ['updated_at', 'timestamp with time zone', 'NO'], ['version', 'integer', 'NO'],
  ])
  assert.match(columns.find(c => c.column_name === 'public_id').column_default, /gen_random_uuid\(\)/)
  ok('migración K010 aplicada: public_id uuid, version y updated_at NOT NULL')

  const [operator] = await query("INSERT INTO users(email) VALUES ('operador-k010@example.invalid') RETURNING id::text")
  const [outsider] = await query("INSERT INTO users(email) VALUES ('ajeno-k010@example.invalid') RETURNING id::text")
  const [establishment] = await query(`INSERT INTO establishments(name, address, latitude, longitude, time_zone)
    VALUES ('Establecimiento ficticio K010', 'Dirección ficticia', -33.45, -70.66, 'America/Santiago') RETURNING id::text, public_id::text`)
  const [otherEstablishment] = await query(`INSERT INTO establishments(name, address, latitude, longitude, time_zone)
    VALUES ('Otro establecimiento ficticio', 'Otra dirección', -33.46, -70.65, 'America/Santiago') RETURNING id::text, public_id::text`)
  await query('INSERT INTO memberships(user_id, establishment_id) VALUES ($1,$2),($3,$4)',
    [operator.id, establishment.id, outsider.id, otherEstablishment.id])
  ok('datos ficticios: dos operadores, dos establecimientos y sus membresías')

  const useCases = createLotUseCases(createLotRepository(pool), () => NOW)
  const actor = { userId: operator.id }
  const foreign = { userId: outsider.id }

  const draft = await useCases.createDraft(actor, { establishmentId: establishment.public_id, declaration: declaration() })
  assert.equal(draft.establishmentPublicId, establishment.public_id)
  assert.equal(draft.establishmentId, establishment.id)
  assert.notEqual(draft.establishmentPublicId, establishment.id)
  await failsWith('PK interna no es ID HTTP', useCases.createDraft(actor, { establishmentId: establishment.id, declaration: declaration() }), 'establishment_not_found')
  assert.equal(draft.status, 'draft')
  assert.equal(draft.version, 1)
  assert.equal(draft.publishedAt, null)
  assert.match(draft.publicId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  const [stored] = await query('SELECT status, version, quantity, published_at, public_id::text FROM lots WHERE public_id=$1',
    [draft.publicId])
  assert.deepEqual(stored, { status: 'draft', version: 1, quantity: 3, published_at: null, public_id: draft.publicId })
  ok('borrador persistido con identificador público opaco y versión 1')

  await failsWith('operador ajeno crea en establecimiento ajeno',
    useCases.createDraft(foreign, { establishmentId: establishment.public_id, declaration: declaration() }), 'not_authorized')
  await failsWith('operador ajeno consulta el lote', useCases.getLot(foreign, draft.publicId), 'not_authorized')
  await failsWith('operador ajeno publica el lote',
    useCases.publish(foreign, { publicId: draft.publicId, expectedVersion: 1 }), 'not_authorized')
  await failsWith('operador ajeno edita el lote', useCases.updateDraft(foreign, {
    publicId: draft.publicId, expectedVersion: 1, declaration: declaration({ quantity: 99 }),
  }), 'not_authorized')
  assert.deepEqual(await query('SELECT quantity, version, status FROM lots WHERE public_id=$1', [draft.publicId]),
    [{ quantity: 3, version: 1, status: 'draft' }])
  ok('ninguna operación ajena modificó la fila')

  await failsWith('cantidad cero',
    useCases.createDraft(actor, { establishmentId: establishment.public_id, declaration: declaration({ quantity: 0 }) }),
    'quantity_out_of_range')
  await failsWith('ventana invertida', useCases.createDraft(actor, {
    establishmentId: establishment.public_id,
    declaration: declaration({ pickupEndsAt: new Date('2026-10-01T14:00:00.000Z') }),
  }), 'pickup_window_invalid')
  assert.deepEqual(await query('SELECT count(*)::int AS total FROM lots'), [{ total: 1 }])
  ok('las declaraciones inválidas no insertan filas')

  const updated = await useCases.updateDraft(actor, {
    publicId: draft.publicId, expectedVersion: 1, declaration: declaration({ quantity: 5 }),
  })
  assert.equal(updated.version, 2)
  assert.equal(updated.declaration.quantity, 5)
  await failsWith('edición con versión superada', useCases.updateDraft(actor, {
    publicId: draft.publicId, expectedVersion: 1, declaration: declaration({ quantity: 9 }),
  }), 'version_conflict')
  assert.deepEqual(await query('SELECT quantity, version FROM lots WHERE public_id=$1', [draft.publicId]),
    [{ quantity: 5, version: 2 }])
  ok('versión optimista: la edición vigente se aplica y la superada se rechaza sin sobrescribir')

  // Dos publicaciones simultáneas del mismo lote: el bloqueo de fila serializa
  // ambas transacciones y solo una puede consumir la versión leída.
  const attempts = await Promise.allSettled([
    useCases.publish(actor, { publicId: draft.publicId, expectedVersion: 2 }),
    useCases.publish(actor, { publicId: draft.publicId, expectedVersion: 2 }),
  ])
  const fulfilled = attempts.filter(result => result.status === 'fulfilled')
  const rejected = attempts.filter(result => result.status === 'rejected')
  assert.equal(fulfilled.length, 1, 'exactamente una publicación confirma')
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason.code, 'version_conflict')
  const [published] = await query(`SELECT status, version, quantity,
    published_at = updated_at AS same_instant FROM lots WHERE public_id=$1`, [draft.publicId])
  assert.deepEqual(published, { status: 'published', version: 3, quantity: 5, same_instant: true })
  assert.equal(fulfilled[0].value.publishedAt.toISOString(), NOW.toISOString())
  ok('publicación concurrente: una sola transición, versión 3 y un único published_at')

  await failsWith('editar un lote publicado', useCases.updateDraft(actor, {
    publicId: draft.publicId, expectedVersion: 3, declaration: declaration({ quantity: 99 }),
  }), 'published_lot_is_immutable')
  await failsWith('publicar dos veces',
    useCases.publish(actor, { publicId: draft.publicId, expectedVersion: 3 }), 'lot_already_published')
  assert.deepEqual(await query('SELECT quantity, version, status FROM lots WHERE public_id=$1', [draft.publicId]),
    [{ quantity: 5, version: 3, status: 'published' }])
  ok('RF02: el lote publicado quedó inmutable')

  const lateWindow = await useCases.createDraft(actor, {
    establishmentId: establishment.public_id,
    declaration: declaration({ pickupStartsAt: new Date('2026-09-01T15:00:00.000Z'), pickupEndsAt: new Date('2026-09-01T17:00:00.000Z') }),
  })
  await failsWith('publicar con la ventana terminada',
    useCases.publish(actor, { publicId: lateWindow.publicId, expectedVersion: 1 }), 'pickup_window_already_ended')

  assert.equal(await useCases.getLot(actor, draft.publicId).then(lot => lot.publicId), draft.publicId)
  await failsWith('identificador inexistente',
    useCases.getLot(actor, '11111111-1111-4111-8111-111111111111'), 'lot_not_found')
  await failsWith('identificador con otra forma', useCases.getLot(actor, 'no-es-uuid'), 'lot_not_found')
  ok('un identificador inexistente o con otra forma no consulta datos ajenos')

  // Dos transacciones reales compiten por la misma versión: editar/publicar.
  const racing = await useCases.createDraft(actor, { establishmentId: establishment.public_id, declaration: declaration() })
  const mixed = await Promise.allSettled([
    useCases.updateDraft(actor, { publicId: racing.publicId, expectedVersion: 1, declaration: { quantity: 7 } }),
    useCases.publish(actor, { publicId: racing.publicId, expectedVersion: 1 }),
  ])
  assert.equal(mixed.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(mixed.filter(r => r.status === 'rejected').length, 1)
  assert.equal(mixed.find(r => r.status === 'rejected').reason.code, 'version_conflict')
  const afterRace = await useCases.getLot(actor, racing.publicId)
  assert.equal(afterRace.version, 2)
  assert.equal(afterRace.declaration.quantity, afterRace.status === 'draft' ? 7 : 3)
  ok('edición/publicación concurrentes: solo un ganador y conflicto concreto, sin mezcla de estados')

  // Fallo SQL después de una escritura real dentro de la unidad atómica.
  const repository = createLotRepository(pool)
  const beforeFailure = await useCases.getLot(actor, lateWindow.publicId)
  await assert.rejects(repository.withLotTransaction(lateWindow.publicId, async (lot, writer) => {
    await writer.updateDeclaration({ publicId: lot.publicId, expectedVersion: lot.version,
      declaration: { ...lot.declaration, quantity: 9 }, updatedAt: NOW })
    await writer.updateDeclaration({ publicId: lot.publicId, expectedVersion: lot.version + 1,
      declaration: { ...lot.declaration, quantity: 0 }, updatedAt: NOW })
  }), error => error.code === '23514')
  assert.deepEqual(await useCases.getLot(actor, lateWindow.publicId), beforeFailure)
  ok('fallo SQL tras escribir: ROLLBACK revierte datos/versión y libera conexión')

  // Fallo después de marcar publicado: ningún estado parcial queda confirmado.
  const unpublished = await useCases.createDraft(actor, { establishmentId: establishment.public_id, declaration: declaration() })
  const failingUseCases = createLotUseCases({ ...repository,
    withLotTransaction: (id, operate) => repository.withLotTransaction(id, (lot, writer) => operate(lot, {
      ...writer, markPublished: async publication => {
        await writer.markPublished(publication)
        throw new Error('fallo simulado después de escribir publicación')
      },
    })),
  }, () => NOW)
  await assert.rejects(failingUseCases.publish(actor, { publicId: unpublished.publicId, expectedVersion: 1 }), /fallo simulado/)
  assert.deepEqual(await useCases.getLot(actor, unpublished.publicId), unpublished)
  ok('fallo después de publicación: rollback conserva borrador, versión y published_at')

  // La migración adicional revierte y reaplica sobre establecimientos existentes.
  // Primero se revierte K008. Su precondición users vacío impide reaplicarla
  // sobre estos fixtures: el ciclo histórico apunta explícitamente hasta K010.
  const usersBeforeRollback = await query('SELECT id, email, created_at FROM users ORDER BY id')
  run('down', '1')
  assert.deepEqual(await query('SELECT id, email, created_at FROM users ORDER BY id'), usersBeforeRollback)
  assert.deepEqual((await query('SELECT name FROM public.pgmigrations ORDER BY id')).map(r => r.name), [
    '1789915246470_migration-tool-test', '1789932753813_initial-rescate-model',
    '1789999138556_lots-publication-fields', '1790000000000_establishment-public-ids',
  ])
  const lotsBeforeRollback = await query('SELECT public_id::text FROM lots ORDER BY id')
  run('down', '1')
  assert.deepEqual(await query('SELECT public_id::text FROM lots ORDER BY id'), lotsBeforeRollback)
  run('up', '1790000000000', '--timestamp')
  const ids = await query('SELECT public_id::text FROM establishments')
  assert.equal(new Set(ids.map(r => r.public_id)).size, 2)
  assert.ok(ids.every(r => /^[0-9a-f-]{36}$/.test(r.public_id)))
  ok('migración de establecimientos sobre filas existentes: IDs únicos sin cambiar lotes')
  run('down', '1')
  await pool.end()
  run('down', '1')
  const remaining = await query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='lots' AND column_name = ANY($1)`, [['public_id', 'version', 'updated_at']])
  assert.deepEqual(remaining, [], 'el rollback de K010 retira sus columnas')
  assert.deepEqual(await query('SELECT count(*)::int AS total FROM lots'), [{ total: 4 }])
  assert.deepEqual((await query('SELECT name FROM public.pgmigrations ORDER BY id')).map(r => r.name), [
    '1789915246470_migration-tool-test', '1789932753813_initial-rescate-model',
  ])
  ok('rollback solo K010: K002 y K003 conservan historial y los lotes siguen existiendo')

  run('up', '1790000000000', '--timestamp')
  const reapplied = await query("SELECT count(*)::int AS total FROM lots WHERE public_id IS NOT NULL")
  assert.deepEqual(reapplied, [{ total: 4 }])
  run('up', '1790000000000', '--timestamp')
  ok('reaplicación de K010: filas existentes reciben identificador y segunda ejecución sin cambios')

  console.log(`PASS K010: ${checks} comprobaciones sobre PostgreSQL real`)
} finally {
  await client.end()
  await pool.end().catch(() => {})
}
