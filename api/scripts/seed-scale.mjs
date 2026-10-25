// K032: semilla de escala del anexo H de E1 (p. 18) sobre una base aislada y ya migrada.
// 10 establecimientos, 1000 cuentas, 10 000 lotes con 200 vigentes y 50 000 compromisos con
// estados terminales. Los mensajes de chat se agregan cuando exista su tabla (K037).
// Reproducible: los datos salen de SQL con setseed; solo cambian los UUID y los códigos.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import pg from 'pg'
import { createPickupCodes } from '../dist/infrastructure/crypto/pickup-codes.js'

// Lotes vigentes por grupo: con cola (sin stock), para cancelar (A) y para reservar (B).
export const SCALE = { establishments: 10, users: 1000, lots: 10000, current: 200, queued: 20, cancelTargets: 90,
  reserveTargets: 90, commitments: 50000, loadUsers: 50, cancelsPerUser: 15, waitlistHistory: 10000, events: 20000 }
// Cuentas 1–10 operan un establecimiento; 11–60 son las sesiones de carga; 61 es la sonda de EXPLAIN.
const firstLoadUser = SCALE.establishments + 1
const probeUser = firstLoadUser + SCALE.loadUsers
const others = probeUser + 1

const sql = String.raw
const steps = [
  ['establecimientos', sql`INSERT INTO establishments(name, address, latitude, longitude, time_zone)
    SELECT 'K032 Local ' || g, 'Santiago ' || g, -33.45 + (random() - 0.5) * 0.1, -70.66 + (random() - 0.5) * 0.1,
      'America/Santiago' FROM generate_series(1, ${SCALE.establishments}) g`],
  ['cuentas', sql`INSERT INTO users(email) SELECT format('k032-%s@example.invalid', lpad(g::text, 4, '0'))
    FROM generate_series(1, ${SCALE.users}) g`],
  ['consentimientos', sql`INSERT INTO user_consents(user_id, purpose, policy_version, granted_at)
    SELECT id, 'account_email', '2026-10', now() - interval '90 days' FROM users`],
  ['membresías', sql`INSERT INTO memberships(user_id, establishment_id)
    SELECT u.id, e.id FROM generate_series(1, ${SCALE.establishments}) g
    JOIN users u ON u.email = format('k032-%s@example.invalid', lpad(g::text, 4, '0'))
    JOIN (SELECT id, row_number() OVER (ORDER BY id) n FROM establishments) e ON e.n = g`],
  // g ≤ 200 vigentes; el resto es historia de 60 días: 90 % vencidos, 5 % retirados y 5 % borradores.
  ['lotes', sql`INSERT INTO lots(establishment_id, description, category, quantity, address, latitude, longitude, time_zone,
      pickup_starts_at, pickup_ends_at, status, published_at, closed_at, created_at)
    SELECT e.id, 'Pack K032 ' || g, (ARRAY['Panadería','Verduras','Frutas','Lácteos','Preparados'])[1 + g % 5],
      CASE WHEN g <= ${SCALE.queued} THEN 10 WHEN g <= ${SCALE.current} THEN 60 + (random() * 40)::int ELSE 5 + (random() * 95)::int END,
      e.address, e.latitude + (random() - 0.5) * 0.02, e.longitude + (random() - 0.5) * 0.02, 'America/Santiago',
      w.starts, w.starts + w.length,
      (CASE WHEN g <= ${SCALE.current} THEN 'published' WHEN g % 20 = 0 THEN 'draft' WHEN g % 20 = 1 THEN 'withdrawn' ELSE 'expired' END)::lot_status,
      CASE WHEN g <= ${SCALE.current} OR g % 20 <> 0 THEN w.starts - interval '2 hours' END,
      CASE WHEN g > ${SCALE.current} AND g % 20 = 1 THEN w.starts WHEN g > ${SCALE.current} AND g % 20 > 1 THEN w.starts + w.length END,
      w.starts - interval '3 hours'
    FROM generate_series(1, ${SCALE.lots}) g
    JOIN (SELECT id, address, latitude, longitude, row_number() OVER (ORDER BY id) - 1 n FROM establishments) e
      ON e.n = g % ${SCALE.establishments}
    CROSS JOIN LATERAL (SELECT CASE WHEN g <= ${SCALE.current} THEN now() - interval '1 hour'
        ELSE now() - interval '1 day' - (g * interval '60 days' / ${SCALE.lots}) END AS starts,
      interval '1 hour' * (2 + (random() * 22)::int) AS length) w
    ORDER BY g`],
]

// Numeración estable de lotes y cuentas para las consultas siguientes.
const numbered = sql`CREATE TEMP TABLE k032_lots AS SELECT id, row_number() OVER (ORDER BY id) g FROM lots;
  CREATE TEMP TABLE k032_users AS SELECT id, row_number() OVER (ORDER BY id) n FROM users;`

const history = [
  // Historia sobre lotes vencidos: 60 % entregados, 20 % cancelados y 20 % vencidos al cierre.
  ['compromisos históricos', sql`INSERT INTO commitments(user_id, lot_id, quantity, status, created_at, ended_at, idempotency_key)
    SELECT u.id, l.id, 1 + (random() * 2)::int, s.status, l.pickup_starts_at, l.pickup_starts_at + interval '30 minutes', gen_random_uuid()
    FROM generate_series(1, $1::int) i
    JOIN (SELECT id, pickup_starts_at, row_number() OVER (ORDER BY id) - 1 n FROM lots WHERE status = 'expired') l
      ON l.n = i % (SELECT count(*) FROM lots WHERE status = 'expired')
    JOIN k032_users u ON u.n = ${others} + i % (${SCALE.users - others + 1})
    CROSS JOIN LATERAL (SELECT (ARRAY['delivered','delivered','delivered','cancelled','expired'])[1 + i % 5] AS status) s`],
  ['entregas', sql`INSERT INTO deliveries(commitment_id, operator_user_id, quantity, delivered_at, idempotency_key)
    SELECT c.id, m.user_id, c.quantity, c.ended_at, gen_random_uuid()
    FROM commitments c JOIN lots l ON l.id = c.lot_id JOIN memberships m ON m.establishment_id = l.establishment_id
    WHERE c.status = 'delivered'`],
  // Q = F + O + R + E + X: el lote cerrado no conserva libres; lo no entregado pasa a X.
  ['inventario histórico', sql`UPDATE lots l SET quantity = GREATEST(l.quantity, t.used), delivered_quantity = t.delivered,
      expired_quantity = GREATEST(l.quantity, t.used) - t.delivered
    FROM (SELECT lot_id, sum(quantity) FILTER (WHERE status <> 'cancelled')::int used,
        COALESCE(sum(quantity) FILTER (WHERE status = 'delivered'), 0)::int delivered
      FROM commitments GROUP BY lot_id) t WHERE t.lot_id = l.id AND l.status = 'expired'`],
  ['cierre de lotes sin compromisos', sql`UPDATE lots SET expired_quantity = quantity
    WHERE status IN ('expired', 'withdrawn') AND delivered_quantity + expired_quantity = 0`],
  ['espera histórica', sql`INSERT INTO waitlist_entries(user_id, lot_id, requested_quantity, status, offered_quantity, offered_at,
      offer_expires_at, idempotency_key, created_at, ended_at)
    SELECT u.id, l.id, 2, s.status, o.quantity, o.at, o.at + interval '10 minutes', gen_random_uuid(), l.pickup_starts_at,
      l.pickup_starts_at + interval '1 hour'
    FROM generate_series(1, ${SCALE.waitlistHistory}) i
    JOIN (SELECT id, pickup_starts_at, row_number() OVER (ORDER BY id) - 1 n FROM lots WHERE status = 'expired') l
      ON l.n = (i * 7) % (SELECT count(*) FROM lots WHERE status = 'expired')
    JOIN k032_users u ON u.n = ${others} + (i * 13) % (${SCALE.users - others + 1})
    CROSS JOIN LATERAL (SELECT (ARRAY['expired','declined','left'])[1 + i % 3] AS status) s
    CROSS JOIN LATERAL (SELECT CASE WHEN s.status = 'left' THEN NULL ELSE 1 END AS quantity,
      CASE WHEN s.status = 'left' THEN NULL ELSE l.pickup_starts_at + interval '10 minutes' END AS at) o`],
  // Avisos procesados con su evento, repartidos entre todas las cuentas.
  ['avisos', sql`WITH e AS (INSERT INTO outbox_events(event_type, subject_id, recipient_user_id, payload, created_at, status,
        available_at, processed_at)
      SELECT 'reservation_confirmed', c.id, c.user_id, jsonb_build_object('lot', jsonb_build_object('id', l.public_id,
          'description', l.description), 'quantity', c.quantity, 'waitlistEntryId', NULL, 'reservationId', c.public_id,
          'offerExpiresAt', NULL), c.created_at, 'processed', c.created_at, c.created_at
      FROM commitments c JOIN lots l ON l.id = c.lot_id ORDER BY c.id LIMIT ${SCALE.events}
      RETURNING id, recipient_user_id, payload, created_at)
    INSERT INTO notifications(event_id, user_id, kind, payload, created_at, read_at)
    SELECT id, recipient_user_id, 'reservation_confirmed', payload, created_at,
      CASE WHEN id % 4 = 0 THEN NULL ELSE created_at END FROM e`],
]

const current = [
  // Lotes con cola: el stock está reservado y cinco personas esperan en orden.
  ['cola vigente', sql`INSERT INTO waitlist_entries(user_id, lot_id, requested_quantity, idempotency_key, created_at)
    SELECT u.id, l.id, 1 + k % 3, gen_random_uuid(), now() - interval '30 minutes' + k * interval '1 minute'
    FROM k032_lots l CROSS JOIN generate_series(1, 5) k
    JOIN k032_users u ON u.n = ${others} + 500 + (l.g * 5 + k) % 400
    WHERE l.g <= ${SCALE.queued} ORDER BY l.g, k`],
]

/** Reservas confirmadas con código cifrado, como las deja K022. `rows` es [usuario, lote]. */
async function confirm(db, codes, rows) {
  const ids = []
  for (const [userId, lotId] of rows) {
    const code = codes.issue()
    ids.push((await db.query(`INSERT INTO commitments(user_id, lot_id, quantity, status, created_at, idempotency_key,
        pickup_code_ciphertext, pickup_code_fingerprint)
      VALUES ($1, $2, 1, 'confirmed', now() - interval '20 minutes', gen_random_uuid(), $3, $4)
      RETURNING public_id::text`, [userId, lotId, Buffer.from(code.ciphertext), Buffer.from(code.fingerprint)])).rows[0].public_id)
  }
  return ids
}

async function sessionFor(db, userId) {
  const bytes = randomBytes(32)
  await db.query(`INSERT INTO sessions(user_id, token_hash, created_at, expires_at)
    VALUES ($1, $2, now(), now() + interval '12 hours')`, [userId, createHash('sha256').update(bytes).digest()])
  return bytes.toString('base64url')
}

/**
 * Siembra la base y devuelve lo que necesitan k6 y la sonda: sesiones, lotes por grupo y
 * reservas confirmadas para cancelar. `pickupCodeKey` debe ser la misma de la API.
 */
export async function seedScale(connectionString, pickupCodeKey, log = () => {}) {
  assert.ok(/^rescate_k032_/.test(new URL(connectionString).pathname.slice(1)), 'Se requiere base aislada rescate_k032_*')
  const db = new pg.Client({ connectionString })
  const codes = createPickupCodes(pickupCodeKey)
  await db.connect()
  try {
    assert.equal((await db.query('SELECT count(*)::int n FROM lots')).rows[0].n, 0, 'La semilla espera una base recién migrada')
    await db.query('BEGIN')
    await db.query('SELECT setseed(0.032)')
    for (const [label, text] of steps) log(`${label}: ${(await db.query(text)).rowCount}`)
    await db.query(numbered)
    const lotIds = (await db.query('SELECT id::text, g::int FROM k032_lots WHERE g <= $1 ORDER BY g', [SCALE.current])).rows
    const userIds = (await db.query('SELECT id::text, n::int FROM k032_users ORDER BY n')).rows.map(row => row.id)
    const user = n => userIds[n - 1]
    const queued = lotIds.slice(0, SCALE.queued)
    const cancelLots = lotIds.slice(SCALE.queued, SCALE.queued + SCALE.cancelTargets)
    const reserveLots = lotIds.slice(SCALE.queued + SCALE.cancelTargets)

    // Vigentes: los lotes con cola quedan sin stock y los de reserva tienen cinco compromisos de otras cuentas.
    await confirm(db, codes, queued.flatMap(lot => Array.from({ length: 10 }, (_, k) => [user(others + 100 + (lot.g * 10 + k) % 400), lot.id])))
    await confirm(db, codes, reserveLots.flatMap(lot => Array.from({ length: 5 }, (_, k) => [user(others + (lot.g * 5 + k) % 100), lot.id])))
    // Cada sesión de carga tiene sus reservas para cancelar, en lotes donde no reservará.
    const cancels = []
    for (let u = 0; u < SCALE.loadUsers; u++) {
      cancels.push(await confirm(db, codes, Array.from({ length: SCALE.cancelsPerUser },
        (_, k) => [user(firstLoadUser + u), cancelLots[(u + k * 7) % cancelLots.length].id])))
    }
    const probeCancels = await confirm(db, codes, [[user(probeUser), cancelLots[0].id], [user(probeUser), cancelLots[1].id]])
    const reserved = sql`UPDATE lots l SET reserved_quantity = t.r FROM (SELECT lot_id, sum(quantity)::int r FROM commitments
      WHERE status = 'confirmed' GROUP BY lot_id) t WHERE t.lot_id = l.id`
    log(`reservas vigentes: ${(await db.query(reserved)).rowCount} lotes`)

    const remaining = SCALE.commitments - Number((await db.query('SELECT count(*) n FROM commitments')).rows[0].n)
    for (const [label, text] of history) {
      log(`${label}: ${(await db.query(text, label === 'compromisos históricos' ? [remaining] : [])).rowCount}`)
    }
    for (const [label, text] of current) log(`${label}: ${(await db.query(text)).rowCount}`)

    const sessions = []
    for (let u = 0; u < SCALE.loadUsers; u++) sessions.push(await sessionFor(db, user(firstLoadUser + u)))
    const probe = await sessionFor(db, user(probeUser))
    const publicIds = async rows => (await db.query(`SELECT public_id::text FROM lots WHERE id = ANY($1::bigint[])
      ORDER BY array_position($1::bigint[], id)`, [rows.map(row => row.id)])).rows.map(row => row.public_id)
    const counts = (await db.query(`SELECT (SELECT count(*) FROM lots)::int lots,
        (SELECT count(*) FROM lots WHERE status = 'published' AND pickup_ends_at > now())::int current,
        (SELECT count(*) FROM commitments)::int commitments, (SELECT count(*) FROM deliveries)::int deliveries,
        (SELECT count(*) FROM waitlist_entries)::int waitlist, (SELECT count(*) FROM notifications)::int notifications,
        (SELECT count(*) FROM lots WHERE quantity <> free_quantity + offered_quantity + reserved_quantity
          + delivered_quantity + expired_quantity OR free_quantity < 0)::int unbalanced`)).rows[0]
    assert.equal(counts.unbalanced, 0, 'La semilla dejó inventario descuadrado')
    assert.equal(counts.commitments, SCALE.commitments)
    await db.query('ANALYZE')
    await db.query('COMMIT')
    return { counts, sessions, cancels, reserveLots: await publicIds(reserveLots), queuedLots: await publicIds(queued),
      probe: { session: probe, cancels: probeCancels } }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  } finally { await db.end() }
}
