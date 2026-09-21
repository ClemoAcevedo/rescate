// K008 etapa 1B: constraints y política de persistencia, no autenticación.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

export const identityTables = ['user_credentials', 'sessions', 'login_security_state', 'login_failures']

export async function applyIdentityWithPendingInsert(client) {
  // Un INSERT todavía no confirmado es invisible para otro snapshot, pero
  // retiene un lock. K008 debe esperar ANTES de comprobar que users está vacío.
  await client.query('BEGIN')
  let child
  let finished
  let transactionOpen = true
  try {
    await client.query("INSERT INTO users(email) VALUES ('uncommitted-k008@example.invalid')")
    child = spawn(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up'], {
      env: { ...process.env, PGAPPNAME: 'k008-migration-lock-test' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    const deadline = Date.now() + 10000
    let waiting = false
    while (Date.now() < deadline) {
      const { rows } = await client.query(`SELECT 1 FROM pg_locks
        WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND relation='public.users'::regclass AND mode='AccessExclusiveLock' AND NOT granted`)
      if (rows.length) { waiting = true; break }
      if (child.exitCode !== null) break
      await delay(25)
    }
    assert.ok(waiting, 'la migración debe esperar el INSERT concurrente antes de inspeccionar users')
    // Fixture nunca confirmado: no se borra ninguna cuenta existente.
    await client.query('ROLLBACK')
    transactionOpen = false
    assert.equal(await finished, 0, output)
  } finally {
    if (transactionOpen) await client.query('ROLLBACK')
    if (child && child.exitCode === null) child.kill()
    if (finished) await finished
  }
}

async function verifyEmailPolicy(query, rejected) {
  // El futuro port llama a esta función: no duplica lower/trim en JavaScript.
  const examples = [
    ['  Clemente+Test@GMAIL.COM  ', 'clemente+test@gmail.com'],
    ['\t\n ANA.PÉREZ+ÑOÑO@EXAMPLE.COM\r\n', 'ana.pérez+ñoño@example.com'],
    ['\u00a0\u2003\ufeffAna@Example.com\u202f\u3000', 'ana@example.com'],
    ['İI@EXAMPLE.COM', 'i\u0307i@example.com'],
    ['ΟΣ@EXAMPLE.COM', 'ος@example.com'],
    ['ẞ@EXAMPLE.COM', 'ß@example.com'],
    ['𐐀@EXAMPLE.COM', '𐐨@example.com'],
    ['E\u0301@EXAMPLE.COM', 'e\u0301@example.com'],
    ['É@EXAMPLE.COM', 'é@example.com'],
    ['A B@EXAMPLE.COM', 'a b@example.com'],
    ['\u200bA@EXAMPLE.COM\u200b', '\u200ba@example.com\u200b'],
    ['\u0085A@EXAMPLE.COM\u0085', '\u0085a@example.com\u0085'],
    ['\u180eA@EXAMPLE.COM\u180e', '\u180ea@example.com\u180e'],
    ['\ufeff\u00a0\n', ''],
  ]
  for (const [input, expected] of examples) {
    const [row] = await query('SELECT public.canonicalize_email($1) AS email', [input])
    assert.equal(row.email, expected, JSON.stringify(input))
    assert.equal((await query('SELECT public.canonicalize_email($1) AS email', [row.email]))[0].email, expected,
      'la representación canónica es idempotente')
  }
  // Comprueba cada carácter de trim, no solo el espacio ASCII.
  const whitespace = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
  for (const char of whitespace) {
    assert.equal((await query('SELECT public.canonicalize_email($1) AS email', [`${char}A@B.COM${char}`]))[0].email, 'a@b.com')
    await rejected('INSERT INTO users(email) VALUES ($1)', [`${char}a@b.com${char}`], '23514', 'users_email_canonical_check')
  }
  await rejected('INSERT INTO users(email) VALUES ($1)', ['Ana@Example.com'], '23514', 'users_email_canonical_check')
  await rejected('INSERT INTO users(email) VALUES ($1)', ['\u00a0'], '23514', 'users_email_canonical_check')
  await query('INSERT INTO users(email) VALUES (public.canonicalize_email($1))', [' Ana.Unique+Tag@EXAMPLE.COM '])
  await rejected('INSERT INTO users(email) VALUES (public.canonicalize_email($1))',
    ['ana.unique+tag@example.com'], '23505', 'users_email_key')
  // No hay reglas de proveedor ni eliminación de acentos/normalización Unicode.
  for (const email of ['anaunique+tag@example.com', 'ana.unique@example.com', 'é@example.com', 'e\u0301@example.com', 'e@example.com']) {
    await query('INSERT INTO users(email) VALUES ($1)', [email])
  }
}

export async function verifyIdentitySchema(client) {
  const query = async (sql, values) => (await client.query(sql, values)).rows
  const rejected = async (sql, values, code, constraint) => {
    await query('SAVEPOINT invalid_input')
    await assert.rejects(client.query(sql, values), error => {
      assert.equal(error.code, code)
      if (constraint) assert.equal(error.constraint, constraint)
      return true
    })
    await query('ROLLBACK TO SAVEPOINT invalid_input')
    await query('RELEASE SAVEPOINT invalid_input')
  }

  // Fixtures nuevos y sintéticos. Nunca asigna credenciales a cuentas previas.
  await query('BEGIN')
  try {
    await verifyEmailPolicy(query, rejected)
    const [user] = await query("INSERT INTO users(email) VALUES ('schema-k008@example.invalid') RETURNING id::text, public_id::text")
    const [other] = await query("INSERT INTO users(email) VALUES ('schema-k008-other@example.invalid') RETURNING id::text, public_id::text")
    assert.match(user.public_id, /^[0-9a-f-]{36}$/)
    assert.notEqual(user.public_id, other.public_id)
    await rejected('UPDATE users SET public_id=$1 WHERE id=$2', [user.public_id, other.id], '23505', 'users_public_id_key')
    await rejected('UPDATE users SET public_id=NULL WHERE id=$1', [user.id], '23502')
    assert.deepEqual(await query('SELECT * FROM user_credentials WHERE user_id=$1', [user.id]), [])

    // Bytes de fixture: prueban almacenamiento, no hashes/secretos funcionales.
    const credential = [user.id, Buffer.alloc(64, 1), Buffer.alloc(16, 2), 131072, 8, 1]
    const insertCredential = `INSERT INTO user_credentials
      (user_id,password_hash,password_salt,scrypt_n,scrypt_r,scrypt_p) VALUES ($1,$2,$3,$4,$5,$6)`
    await query(insertCredential, credential)
    await rejected(insertCredential, credential, '23505', 'user_credentials_pkey')
    await rejected(insertCredential, ['-1', ...credential.slice(1)], '23503', 'user_credentials_user_id_fkey')
    for (const [column, value, constraint] of [
      ['password_hash', Buffer.alloc(63), 'user_credentials_hash_length_check'],
      ['password_salt', Buffer.alloc(15), 'user_credentials_salt_length_check'],
      ['scrypt_n', 3, 'user_credentials_scrypt_n_check'],
      ['scrypt_n', 1, 'user_credentials_scrypt_n_check'],
      ['scrypt_r', 0, 'user_credentials_scrypt_r_check'],
      ['scrypt_p', 0, 'user_credentials_scrypt_p_check'],
    ]) await rejected(`UPDATE user_credentials SET ${column}=$1 WHERE user_id=$2`, [value, user.id], '23514', constraint)
    await rejected('UPDATE user_credentials SET password_hash=NULL WHERE user_id=$1', [user.id], '23502')
    const defaults = await query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='user_credentials' AND column_default IS NOT NULL`)
    assert.deepEqual(defaults, [], 'no hay costos ni material criptográfico predeterminados')

    const insertSession = `INSERT INTO sessions (user_id,token_hash,created_at,expires_at)
      VALUES ($1,$2,'2030-01-01T00:00:00Z','2030-01-01T12:00:00Z') RETURNING id::text`
    const [session] = await query(insertSession, [user.id, Buffer.alloc(32, 3)])
    await query(insertSession, [user.id, Buffer.alloc(32, 4)])
    await rejected(insertSession, [other.id, Buffer.alloc(32, 3)], '23505', 'sessions_token_hash_key')
    await rejected(insertSession, [user.id, Buffer.alloc(31)], '23514', 'sessions_token_hash_length_check')
    await rejected(insertSession, ['-1', Buffer.alloc(32, 5)], '23503', 'sessions_user_id_fkey')
    await rejected("UPDATE sessions SET expires_at=created_at+interval '13 hours' WHERE id=$1", [session.id], '23514', 'sessions_lifetime_check')
    await rejected("UPDATE sessions SET created_at='infinity', expires_at='infinity' WHERE id=$1", [session.id], '23514', 'sessions_lifetime_check')
    await rejected("UPDATE sessions SET revoked_at=created_at-interval '1 second' WHERE id=$1", [session.id], '23514', 'sessions_revocation_check')
    await rejected("UPDATE sessions SET revoked_at='infinity' WHERE id=$1", [session.id], '23514', 'sessions_revocation_check')
    await query('UPDATE sessions SET revoked_at=created_at WHERE id=$1', [session.id])
    const columns = await query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='sessions' ORDER BY ordinal_position`)
    assert.deepEqual(columns.map(row => row.column_name), ['id', 'user_id', 'token_hash', 'created_at', 'expires_at', 'revoked_at'])

    await query('INSERT INTO login_security_state(user_id) VALUES ($1)', [user.id])
    await rejected('INSERT INTO login_security_state(user_id) VALUES ($1)', [user.id], '23505', 'login_security_state_pkey')
    await rejected('INSERT INTO login_security_state(user_id) VALUES (-1)', [], '23503', 'login_security_state_user_id_fkey')
    await rejected("UPDATE login_security_state SET blocked_until='infinity' WHERE user_id=$1", [user.id], '23514', 'login_security_state_blocked_until_check')
    await rejected("INSERT INTO login_failures(user_id,failed_at) VALUES ($1,now())", [other.id], '23503', 'login_failures_user_id_fkey')
    await rejected("INSERT INTO login_failures(user_id,failed_at) VALUES ($1,'infinity')", [user.id], '23514', 'login_failures_failed_at_check')
    await query(`INSERT INTO login_failures(user_id,failed_at)
      VALUES ($1,'2030-01-01T10:00:00Z'),($1,'2030-01-01T10:00:00Z')`, [user.id])
    assert.equal((await query('SELECT id FROM login_failures WHERE user_id=$1', [user.id])).length, 2,
      'dos fallos pueden compartir instante; no se deduplican')
    await rejected('DELETE FROM login_security_state WHERE user_id=$1', [user.id], '23503', 'login_failures_user_id_fkey')
    await rejected('DELETE FROM users WHERE id=$1', [user.id], '23503')
  } finally {
    await query('ROLLBACK')
  }
}
