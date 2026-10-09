import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { createPasswordHasher } from '../dist/infrastructure/crypto/passwords.js'
import { demoAccounts, establishments, lots, createLotInput, DEMO_PASSWORD } from '../fixtures/demo-data.mjs'

async function seedLots(db, establishmentIds, refreshExpiredLots) {
  let created = 0, refreshed = 0
  const now = Date.now()
  for (const fixture of lots) {
    const establishment = establishments.find(item => item.id === fixture.establishmentId)
    const input = createLotInput(establishment, now)
    const establishmentId = establishmentIds.get(fixture.establishmentId)
    const result = await db.query(`INSERT INTO lots(public_id,establishment_id,description,category,quantity,conditions,
      address,latitude,longitude,time_zone,pickup_starts_at,pickup_ends_at,status,version,published_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (public_id) DO NOTHING`, [fixture.id, establishmentId,
      `${input.description} — ${fixture.status === 'draft' ? 'borrador' : 'publicado'}`,
      input.category, input.quantity, input.conditions, input.address, input.latitude, input.longitude,
      input.timeZone, input.pickupStartsAt, input.pickupEndsAt, fixture.status,
      fixture.status === 'draft' ? 1 : 2, fixture.status === 'draft' ? null : new Date(now)])
    created += result.rowCount
    const existing = (await db.query('SELECT establishment_id FROM lots WHERE public_id=$1', [fixture.id])).rows[0]
    assert.equal(existing.establishment_id, establishmentId, 'ID de lote semilla ocupado por otro establecimiento')
    if (refreshExpiredLots) {
      const updated = await db.query(`UPDATE lots
        SET pickup_starts_at=$2, pickup_ends_at=$3, version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE public_id=$1 AND pickup_ends_at <= $4`,
      [fixture.id, input.pickupStartsAt, input.pickupEndsAt, new Date(now)])
      refreshed += updated.rowCount
    }
  }
  return { lotsCreated: created, lotsRefreshed: refreshed }
}

async function verifyExistingAccounts(db, passwords, existingUsers, existingEstablishments) {
  assert.deepEqual(existingUsers.rows, demoAccounts.map(a => ({ public_id: a.id, email: a.email })), 'Semilla parcial o modificada; no se sobrescribe')
  assert.deepEqual(existingEstablishments.rows, establishments.map(({ id, ...e }) => ({ public_id: id, ...e, time_zone: 'America/Santiago' })), 'Establecimientos modificados; no se sobrescriben')
  const memberships = await db.query(`SELECT u.public_id AS user_id, e.public_id AS establishment_id
    FROM memberships m JOIN users u ON u.id=m.user_id JOIN establishments e ON e.id=m.establishment_id
    WHERE u.public_id=ANY($1::uuid[]) ORDER BY u.public_id, e.public_id`, [demoAccounts.map(a => a.id)])
  assert.deepEqual(memberships.rows, demoAccounts.filter(a => a.establishmentId !== null).map(a => ({ user_id: a.id, establishment_id: a.establishmentId })),
    'Permisos de la semilla modificados; no se restauran automáticamente')
  for (const account of demoAccounts) {
    const credential = (await db.query(`SELECT c.* FROM user_credentials c JOIN users u ON u.id=c.user_id WHERE u.public_id=$1`, [account.id])).rows[0]
    assert.ok(credential, 'Falta credencial; no se reemplaza')
    assert.ok(await passwords.verify(DEMO_PASSWORD, { hash: credential.password_hash, salt: credential.password_salt,
      parameters: { N: credential.scrypt_n, r: credential.scrypt_r, p: credential.scrypt_p } }), 'Credencial modificada; no se reemplaza')
  }
}

async function insertAccountsAndEstablishments(db, passwords) {
  const establishmentIds = new Map()
  for (const e of establishments) {
    const row = (await db.query(`INSERT INTO establishments(public_id,name,address,latitude,longitude,time_zone)
      VALUES ($1,$2,$3,$4,$5,'America/Santiago') RETURNING id`, [e.id, e.name, e.address, e.latitude, e.longitude])).rows[0]
    establishmentIds.set(e.id, row.id)
  }
  for (const account of demoAccounts) {
    const credential = await passwords.hash(DEMO_PASSWORD)
    const user = (await db.query('INSERT INTO users(public_id,email) VALUES ($1,$2) RETURNING id', [account.id, account.email])).rows[0]
    await db.query(`INSERT INTO user_credentials(user_id,password_hash,password_salt,scrypt_n,scrypt_r,scrypt_p)
      VALUES ($1,$2,$3,$4,$5,$6)`, [user.id, Buffer.from(credential.hash), Buffer.from(credential.salt),
      credential.parameters.N, credential.parameters.r, credential.parameters.p])
    await db.query(`INSERT INTO user_consents(user_id,purpose,policy_version,granted_at)
      VALUES ($1,'account_email','2026-10',now())`, [user.id])
    if (account.establishmentId !== null) await db.query('INSERT INTO memberships(user_id,establishment_id) VALUES ($1,$2)', [user.id, establishmentIds.get(account.establishmentId)])
  }
}

export async function seedDemoData(connectionString = process.env.DATABASE_URL, { refreshExpiredLots = false } = {}) {
  assert.notEqual(process.env.NODE_ENV, 'production', 'La semilla es solo local')
  assert.ok(connectionString, 'Falta DATABASE_URL para la base local')
  const url = new URL(connectionString)
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'Se requiere PostgreSQL')
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'La semilla exige una base local')
  assert.match(url.pathname, /^\/rescate(?:_[a-z0-9_]+)?$/, 'Se requiere una base local rescate o rescate_*')
  assert.equal(url.search, '', 'No se admiten parámetros que sustituyan la conexión local')
  const db = new pg.Client({ connectionString })
  const passwords = createPasswordHasher()
  try {
    await db.connect()
    await db.query('BEGIN')
    await db.query("SELECT pg_advisory_xact_lock(12012)")
    assert.match((await db.query('SELECT current_database() name')).rows[0].name, /^rescate(?:_[a-z0-9_]+)?$/)
    const existingUsers = await db.query('SELECT public_id, email FROM users WHERE public_id = ANY($1::uuid[]) OR email = ANY($2::text[]) ORDER BY public_id',
      [demoAccounts.map(a => a.id), demoAccounts.map(a => a.email)])
    const existingEstablishments = await db.query('SELECT public_id, name, address, latitude, longitude, time_zone FROM establishments WHERE public_id = ANY($1::uuid[]) ORDER BY public_id',
      [establishments.map(e => e.id)])
    const accountsCreated = existingUsers.rowCount === 0 && existingEstablishments.rowCount === 0
    if (accountsCreated) {
      await insertAccountsAndEstablishments(db, passwords)
    } else {
      await verifyExistingAccounts(db, passwords, existingUsers, existingEstablishments)
    }
    const rows = await db.query('SELECT id, public_id FROM establishments WHERE public_id=ANY($1::uuid[])',
      [establishments.map(establishment => establishment.id)])
    const establishmentIds = new Map(rows.rows.map(row => [row.public_id, row.id]))
    const lotResult = await seedLots(db, establishmentIds, refreshExpiredLots)
    await db.query('COMMIT')
    return { accountsCreated, ...lotResult }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    assert.ok(args.every(arg => arg === '--refresh-expired-lots'), 'Opción desconocida')
    const result = await seedDemoData(undefined, { refreshExpiredLots: args.includes('--refresh-expired-lots') })
    console.log(result.accountsCreated ? 'K012: 3 cuentas, 2 establecimientos y 2 membresías creados.' : 'K012: cuentas y permisos verificados.')
    console.log(`K012: ${result.lotsCreated} lotes creados; ${result.lotsRefreshed} ventanas de retiro renovadas.`)
  } catch {
    console.error('FAIL semilla K012. Revisar DATABASE_URL local, migraciones, datos existentes y opción --refresh-expired-lots.')
    process.exitCode = 1
  }
}
