import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import pg from 'pg'

// Destructiva SOLO para K003: exige nombre dedicado y base inicialmente vacía.
assert.ok(process.env.DATABASE_URL, 'Configura DATABASE_URL para una base de prueba vacía')
const migrations = [
  '1789915246470_migration-tool-test',
  '1789932753813_initial-rescate-model',
]
assert.deepEqual(readdirSync('migrations').sort(), migrations.map(name => `${name}.sql`),
  'Revisar explícitamente la prueba antes de incluir nuevas migraciones y su rollback')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
const run = (direction, ...args) => execFileSync(process.execPath, [
  'node_modules/node-pg-migrate/bin/node-pg-migrate.js', direction, ...args,
], { stdio: 'inherit', env: process.env })
const query = async (sql, values) => (await client.query(sql, values)).rows
const history = () => query('SELECT id, name, run_on FROM public.pgmigrations ORDER BY id')
const tables = ['commitments', 'establishments', 'lots', 'memberships', 'users']
let checks = 0
function ok(message) {
  checks++
  console.log(`OK ${checks}: ${message}`)
}
async function rejected(label, sql, values, code, constraint) {
  await assert.rejects(client.query(sql, values), error => {
    assert.equal(error.code, code, `${label}: SQLSTATE`)
    if (constraint) assert.ok([constraint].flat().includes(error.constraint), `${label}: ${error.constraint}`)
    return true
  }, label)
  ok(`${label}: PostgreSQL rechaza con ${code}${constraint ? ` (${constraint})` : ''}`)
}
const snapshot = () => query(`
  SELECT c.relname, c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname
`)

async function verifyModel() {
  assert.deepEqual((await snapshot()).map(row => row.relname),
    [...tables, 'migration_tool_test', 'pgmigrations'].sort())
  const constraints = await query(`
    SELECT c.conname, t.relname AS table_name, c.contype,
           pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = ANY($1) ORDER BY c.conname
  `, [tables])
  assert.deepEqual(constraints.filter(c => c.contype === 'p').map(c => [c.table_name, c.definition]).sort(),
    tables.map(table => [table, 'PRIMARY KEY (id)']).sort())
  assert.deepEqual(constraints.filter(c => c.contype === 'f').map(c => [c.table_name, c.definition]).sort(), [
    ['memberships', 'FOREIGN KEY (user_id) REFERENCES users(id)'],
    ['memberships', 'FOREIGN KEY (establishment_id) REFERENCES establishments(id)'],
    ['lots', 'FOREIGN KEY (establishment_id) REFERENCES establishments(id)'],
    ['commitments', 'FOREIGN KEY (user_id) REFERENCES users(id)'],
    ['commitments', 'FOREIGN KEY (lot_id) REFERENCES lots(id)'],
  ].sort())
  const ids = await query(`SELECT table_name, data_type, is_identity, identity_generation
    FROM information_schema.columns WHERE table_schema='public'
    AND table_name=ANY($1) AND column_name='id' ORDER BY table_name`, [tables])
  assert.deepEqual(ids, tables.map(table_name => ({ table_name, data_type: 'bigint',
    is_identity: 'YES', identity_generation: 'ALWAYS' })))
  ok('cinco tablas, cinco PK bigint identity y cinco FK reales verificadas en catálogos')

  const [user] = await query("INSERT INTO users(email) VALUES ('persona-k003@example.invalid') RETURNING *")
  const [other] = await query("INSERT INTO users(email) VALUES ('otra-k003@example.invalid') RETURNING *")
  const [establishment] = await query(`INSERT INTO establishments(name, address, latitude, longitude, time_zone)
    VALUES ('Establecimiento ficticio K003', 'Dirección ficticia de prueba', -33.45, -70.66, 'America/Santiago') RETURNING *`)
  const [second] = await query(`INSERT INTO establishments(name, address, latitude, longitude, time_zone)
    VALUES ('Otro establecimiento ficticio', 'Otra dirección ficticia', -33.46, -70.65, 'America/Santiago') RETURNING *`)
  const [membership] = await query('INSERT INTO memberships(user_id, establishment_id) VALUES ($1,$2) RETURNING *',
    [user.id, establishment.id])
  await query('INSERT INTO memberships(user_id, establishment_id) VALUES ($1,$2),($3,$4)',
    [user.id, second.id, other.id, establishment.id])
  ok('usuarios y establecimientos válidos; membresías N:M aceptadas')

  const [lot] = await query(`INSERT INTO lots(establishment_id, description, category, quantity,
    address, latitude, longitude, time_zone, pickup_starts_at, pickup_ends_at)
    VALUES ($1, 'Pack ficticio de prueba', 'Categoría de prueba', 3,
      'Dirección ficticia de retiro', -33.45, -70.66, 'America/Santiago',
      '2026-10-01T12:00:00-03:00', '2026-10-01T14:00:00-03:00') RETURNING *`, [establishment.id])
  assert.equal(lot.status, 'draft')
  assert.equal(lot.published_at, null)
  assert.equal(lot.conditions, null)
  assert.equal(lot.pickup_starts_at.toISOString(), '2026-10-01T15:00:00.000Z')
  await query("UPDATE lots SET status='published', published_at='2026-10-01T10:00:00-03:00' WHERE id=$1", [lot.id])
  const [commitment] = await query(`INSERT INTO commitments(user_id, lot_id, quantity, status)
    VALUES ($1,$2,3,'confirmed') RETURNING *`, [user.id, lot.id])
  const links = await query(`SELECT u.id AS user_id, c.id AS commitment_id, l.id AS lot_id,
    l.establishment_id, c.quantity FROM commitments c
    JOIN users u ON u.id=c.user_id JOIN lots l ON l.id=c.lot_id WHERE c.id=$1`, [commitment.id])
  assert.deepEqual(links, [{ user_id: user.id, commitment_id: commitment.id, lot_id: lot.id,
    establishment_id: establishment.id, quantity: 3 }])
  for (const row of [user, lot, commitment]) assert.ok(row.created_at instanceof Date)
  ok('lote borrador/publicado y compromiso válidos; JOIN usuario → compromiso → lote; 3 packs aceptados')

  for (const [table, row] of [['lots', lot], ['commitments', commitment]]) {
    for (const value of [0, -1]) {
      await rejected(`${table}.quantity=${value}`, `UPDATE ${table} SET quantity=$1 WHERE id=$2`,
        [value, row.id], '23514', `${table}_quantity_check`)
    }
    await rejected(`${table}.quantity=NULL`, `UPDATE ${table} SET quantity=NULL WHERE id=$1`, [row.id], '23502')
    await rejected(`${table}.quantity=1.5 (parámetro)`, `UPDATE ${table} SET quantity=$1 WHERE id=$2`,
      ['1.5', row.id], '22P02')
    await rejected(`${table}.quantity desborda integer`, `UPDATE ${table} SET quantity=$1 WHERE id=$2`,
      ['2147483648', row.id], '22003')
    await query(`UPDATE ${table} SET quantity=1 WHERE id=$1`, [row.id])
    await query(`UPDATE ${table} SET quantity=101 WHERE id=$1`, [row.id])
    await query(`UPDATE ${table} SET quantity=3 WHERE id=$1`, [row.id])
  }
  ok('límites válidos 1 y 101 aceptados; sin imponer supuesto de 100 ni máximo de 2')

  for (const [table, field, row] of [
    ['memberships', 'user_id', membership], ['memberships', 'establishment_id', membership],
    ['lots', 'establishment_id', lot], ['commitments', 'user_id', commitment], ['commitments', 'lot_id', commitment],
  ]) {
    await rejected(`${table}.${field} inexistente`, `UPDATE ${table} SET ${field}=-1 WHERE id=$1`,
      [row.id], '23503', `${table}_${field}_fkey`)
    await rejected(`${table}.${field}=NULL`, `UPDATE ${table} SET ${field}=NULL WHERE id=$1`, [row.id], '23502')
  }
  for (const [table, row] of [['lots', lot], ['commitments', commitment]]) {
    await rejected(`${table}.status inválido`, `UPDATE ${table} SET status='inventado' WHERE id=$1`,
      [row.id], '23514', table === 'lots' ? ['lots_status_check', 'lots_publication_check'] : 'commitments_status_check')
    await rejected(`${table}.status=NULL`, `UPDATE ${table} SET status=NULL WHERE id=$1`, [row.id], '23502')
  }
  await rejected('correo duplicado', 'INSERT INTO users(email) VALUES ($1)', [user.email], '23505', 'users_email_key')
  await rejected('membresía duplicada', 'INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)',
    [user.id, establishment.id], '23505', 'memberships_user_establishment_key')
  await rejected('compromiso activo duplicado', `INSERT INTO commitments(user_id,lot_id,quantity,status)
    VALUES ($1,$2,1,'confirmed')`, [user.id, lot.id], '23505', 'commitments_active_user_lot_key')
  // Unicidad por par: otro usuario sí puede comprometer el mismo lote.
  await query("UPDATE commitments SET quantity=2 WHERE id=$1", [commitment.id])
  await query("INSERT INTO commitments(user_id,lot_id,quantity,status) VALUES ($1,$2,1,'confirmed')", [other.id, lot.id])
  ok('unicidad activa no impide otro usuario en el mismo lote')

  for (const [table, row] of [['users', user], ['establishments', establishment], ['memberships', membership],
    ['lots', lot], ['commitments', commitment]]) {
    await rejected(`PK duplicada ${table}`, `INSERT INTO ${table} OVERRIDING SYSTEM VALUE
      SELECT * FROM ${table} WHERE id=$1`, [row.id], '23505', `${table}_pkey`)
  }
  for (const [table, row] of [['users', user], ['establishments', establishment], ['lots', lot]]) {
    await rejected(`borrado de ${table} referenciado`, `DELETE FROM ${table} WHERE id=$1`, [row.id], '23503')
  }
  await rejected('ventana vacía', 'UPDATE lots SET pickup_ends_at=pickup_starts_at WHERE id=$1',
    [lot.id], '23514', 'lots_pickup_window_check')
  await rejected('ventana invertida', "UPDATE lots SET pickup_ends_at=pickup_starts_at-interval '1 second' WHERE id=$1",
    [lot.id], '23514', 'lots_pickup_window_check')
  await rejected('publicado sin fecha', 'UPDATE lots SET published_at=NULL WHERE id=$1',
    [lot.id], '23514', 'lots_publication_check')
  await rejected('borrador con fecha publicada', "UPDATE lots SET status='draft' WHERE id=$1",
    [lot.id], '23514', 'lots_publication_check')
  for (const [table, row] of [['establishments', establishment], ['lots', lot]]) {
    for (const [field, value] of [['latitude', 91], ['longitude', -181], ['latitude', 'NaN'], ['longitude', 'Infinity']]) {
      await rejected(`${table}.${field}=${value}`, `UPDATE ${table} SET ${field}=$1 WHERE id=$2`,
        [value, row.id], '23514', `${table}_${field}_check`)
    }
  }
  for (const [table, row, fields] of [
    ['users', user, ['email']], ['establishments', establishment, ['name', 'address', 'time_zone']],
    ['lots', lot, ['description', 'category', 'address', 'time_zone']],
  ]) {
    for (const field of fields) await rejected(`${table}.${field} vacío`,
      `UPDATE ${table} SET ${field}=' ' WHERE id=$1`, [row.id], '23514', `${table}_${field}_check`)
  }
  await rejected('descripción excede 2000 caracteres', "UPDATE lots SET description=repeat('x',2001) WHERE id=$1",
    [lot.id], '23514', 'lots_description_check')
}

try {
  await client.connect()
  const [server] = await query("SELECT current_database() AS database, current_setting('server_version') AS version")
  assert.match(server.database, /^rescate_k003_test_[a-z0-9_]+$/, 'Usa una base dedicada rescate_k003_test_*')
  const existing = await query(`SELECT n.nspname, c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','S','f')`)
  assert.deepEqual(existing, [], 'La base debe estar completamente vacía, sin tablas, vistas ni secuencias de usuario')
  ok(`PostgreSQL ${server.version}; base ${server.database}: vacía (0 relaciones de usuario)`)
  run('up')
  assert.deepEqual((await history()).map(row => row.name), migrations)
  ok('desde cero: K002 + K003 registradas una vez')
  await client.query('INSERT INTO public.migration_tool_test(id) VALUES (1)')
  await verifyModel()
  const applied = await history()
  const before = await snapshot()
  const data = await query('SELECT * FROM commitments ORDER BY id')
  run('up')
  assert.deepEqual(await history(), applied)
  assert.deepEqual(await snapshot(), before)
  assert.deepEqual(await query('SELECT * FROM commitments ORDER BY id'), data)
  assert.equal(migrations.filter(name => !applied.some(row => row.name === name)).length, 0)
  ok('segunda ejecución: 0 pendientes; historial, OID de tablas y datos intactos')

  assert.deepEqual((await history()).map(row => row.name), migrations)
  run('down', '1')
  assert.deepEqual(await history(), [applied[0]])
  assert.deepEqual((await snapshot()).map(row => row.relname), ['migration_tool_test', 'pgmigrations'])
  assert.deepEqual(await query('SELECT * FROM migration_tool_test'), [{ id: 1 }])
  assert.deepEqual(await snapshot(), before.filter(row => ['migration_tool_test', 'pgmigrations'].includes(row.relname)))
  ok('rollback solo K003: cinco tablas ausentes; K002 conserva historial, OID y dato')

  run('up')
  assert.deepEqual((await history()).map(row => row.name), migrations)
  assert.deepEqual((await history())[0], applied[0])
  ok('upgrade desde K002/reaplicación: solo K003, sin alterar K002')
  await verifyModel()
  const reapplied = await history()
  run('up')
  assert.deepEqual(await history(), reapplied)
  ok('reaplicación validada con toda la suite; segunda ejecución final: 0 pendientes')
  console.log(`PASS K003: ${checks} comprobaciones; datos ficticios conservados para inspección`)
} finally {
  await client.end()
}
