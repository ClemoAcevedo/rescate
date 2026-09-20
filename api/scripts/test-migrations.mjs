import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import pg from 'pg'

// Prueba destructiva limitada a la tabla técnica, sobre una base nueva para K002.
assert.ok(process.env.DATABASE_URL, 'Configura DATABASE_URL para una base de prueba vacía')
const migration = '1789915246470_migration-tool-test'
assert.deepEqual(readdirSync('migrations'), [`${migration}.sql`],
  'Esta prueba es exclusiva de K002; no ejecutar con migraciones de dominio')

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
})
const run = (direction, ...args) => execFileSync(process.execPath, [
  'node_modules/node-pg-migrate/bin/node-pg-migrate.js', direction, ...args,
], { stdio: 'inherit', env: process.env })
const table = async () => (await client.query(
  "SELECT to_regclass('public.migration_tool_test')::text AS name",
)).rows[0].name
const history = async () => (await client.query(
  'SELECT id, name, run_on FROM public.pgmigrations ORDER BY id',
)).rows

try {
  await client.connect()
  assert.equal(await table(), null, 'La tabla técnica debe estar ausente al inicio')
  const existing = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  )
  assert.equal(existing.rowCount, 0, 'Usa una base nueva sin tablas en public')
  console.log('OK: tabla ausente y public vacío')

  run('up')
  assert.equal(await table(), 'migration_tool_test')
  const applied = await history()
  assert.equal(applied.length, 1)
  assert.equal(applied[0].name, migration)
  await client.query('INSERT INTO public.migration_tool_test (id) VALUES (1)')
  const oid = (await client.query(
    "SELECT 'public.migration_tool_test'::regclass::oid AS oid",
  )).rows[0].oid
  console.log('OK: tabla creada y una migración registrada')

  run('up')
  assert.deepEqual(await history(), applied)
  assert.deepEqual((await client.query('SELECT * FROM public.migration_tool_test')).rows, [{ id: 1 }])
  assert.equal((await client.query(
    "SELECT 'public.migration_tool_test'::regclass::oid AS oid",
  )).rows[0].oid, oid)
  console.log('OK: segunda ejecución conserva historial, tabla y datos')

  run('down', '1')
  assert.equal(await table(), null)
  assert.equal((await history()).length, 0)
  console.log('OK: rollback elimina tabla y registro')

  run('up')
  assert.equal(await table(), 'migration_tool_test')
  assert.equal((await history()).length, 1)
  assert.equal((await history())[0].name, migration)
  assert.equal((await client.query('SELECT * FROM public.migration_tool_test')).rowCount, 0)
  console.log('OK: reaplicación; queda una tabla técnica vacía y un registro')
} finally {
  await client.end()
}
