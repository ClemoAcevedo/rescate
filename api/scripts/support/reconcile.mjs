// K053 · Conciliación de una base restaurada y sus fotos contra el manifiesto de la copia.
// Cada comprobación devuelve las filas que fallan por identificador público (o el id
// interno de un evento del outbox, que no tiene otro), nunca correos, textos ni códigos.
// Las reglas Q = F + O + R + E + X sin negativos ya las garantiza el esquema; aquí se
// repiten junto con lo que el esquema no puede comprobar. Un cambio de contenido que
// conserva conteos y reglas (por ejemplo, una oferta movida a otro lote con sus contadores)
// solo lo detecta el sha256 del volcado, que se verifica antes de restaurar.
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { createPickupCodes } from '../../dist/infrastructure/crypto/pickup-codes.js'
import { describeDatabase, LOCK_WAIT, readyPhotoKeys, repositoryMigrations, sha256 } from './backup.mjs'

const SAMPLE = 5

/** Lotes cuyo inventario no cuadra con sus registros (test-integrity, test-pickup-codes). */
const INVENTORY = `SELECT l.public_id::text AS id FROM public.lots l WHERE
     l.quantity <> l.free_quantity + l.offered_quantity + l.reserved_quantity + l.delivered_quantity + l.expired_quantity
  OR LEAST(l.free_quantity, l.offered_quantity, l.reserved_quantity, l.delivered_quantity, l.expired_quantity) < 0
  OR l.reserved_quantity <> COALESCE((SELECT sum(c.quantity) FROM public.commitments c WHERE c.lot_id = l.id AND c.status = 'confirmed'), 0)
  OR l.offered_quantity <> COALESCE((SELECT sum(w.offered_quantity) FROM public.waitlist_entries w WHERE w.lot_id = l.id AND w.status = 'offered'), 0)
  OR l.delivered_quantity <> COALESCE((SELECT sum(d.quantity) FROM public.deliveries d JOIN public.commitments c ON c.id = d.commitment_id
    WHERE c.lot_id = l.id), 0)
  OR l.status IN ('expired', 'withdrawn') AND (l.free_quantity + l.offered_quantity + l.reserved_quantity <> 0
    OR EXISTS (SELECT 1 FROM public.waitlist_entries w WHERE w.lot_id = l.id AND w.status IN ('waiting', 'offered')))
  ORDER BY 1`

/** Una entrega por compromiso entregado, por la misma cantidad, y ninguna en los demás. */
const DELIVERIES = `SELECT c.public_id::text AS id FROM public.commitments c
  LEFT JOIN public.deliveries d ON d.commitment_id = c.id
  WHERE (c.status = 'delivered') <> (d.id IS NOT NULL) OR d.quantity <> c.quantity ORDER BY 1`

/** Código cifrado solo en reservas confirmadas, y toda reserva confirmada con su código. */
const CODE_STATE = `SELECT public_id::text AS id FROM public.commitments
  WHERE (status = 'confirmed') <> (pickup_code_ciphertext IS NOT NULL) ORDER BY 1`
const DUPLICATED_FINGERPRINTS = `SELECT string_agg(public_id::text, ',' ORDER BY public_id) AS id FROM public.commitments
  WHERE pickup_code_fingerprint IS NOT NULL GROUP BY pickup_code_fingerprint HAVING count(*) > 1`

/**
 * Versión y estado de la incidencia iguales a su última versión publicada, y una versión
 * con el lote cerrado solo si el lote ya estaba cerrado o fuera de plazo al publicarla
 * (un lote cerrado no vuelve a abrirse).
 */
const INCIDENTS = `SELECT i.public_id::text AS id FROM public.incidents i
  LEFT JOIN LATERAL (SELECT v.version, v.status FROM public.incident_versions v WHERE v.incident_id = i.id
    ORDER BY v.version DESC LIMIT 1) last ON true
  WHERE i.version <> COALESCE(last.version, 0) OR (last.version IS NOT NULL AND i.status <> last.status)
    OR (SELECT count(*) FROM public.incident_versions v WHERE v.incident_id = i.id) <> i.version
  UNION SELECT i.public_id::text || '/' || v.version || ' lote cerrado sin cierre' FROM public.incident_versions v
  JOIN public.incidents i ON i.id = v.incident_id JOIN public.lots l ON l.id = i.lot_id
  WHERE v.lot_closed AND l.status NOT IN ('expired', 'withdrawn') AND l.pickup_ends_at > v.created_at ORDER BY 1`

/**
 * Destinatario con evento: del tipo, persona, incidencia y versión que le corresponden;
 * y cada evento de incidencia con su destinatario. Un destinatario que perdió su evento
 * volvería a la cola del dispatcher y el aviso se duplicaría.
 */
const RECIPIENTS = `SELECT i.public_id::text || '/' || r.version AS id FROM public.incident_recipients r
  JOIN public.incidents i ON i.id = r.incident_id
  LEFT JOIN public.outbox_events e ON e.id = r.outbox_event_id
  WHERE r.outbox_event_id IS NOT NULL AND (e.id IS NULL OR e.event_type <> 'incident_version'
    OR e.recipient_user_id <> r.user_id OR e.subject_id <> r.incident_id OR e.version <> r.version)
  UNION SELECT 'evento ' || e.id || ' de ' || COALESCE(i.public_id::text, 'incidencia inexistente') || '/' || e.version
  FROM public.outbox_events e LEFT JOIN public.incidents i ON i.id = e.subject_id
  WHERE e.event_type = 'incident_version'
    AND NOT EXISTS (SELECT 1 FROM public.incident_recipients r WHERE r.outbox_event_id = e.id) ORDER BY 1`

/** Evento procesado con su aviso, pendiente o fallido sin aviso, y aviso igual a su evento. */
const OUTBOX = `SELECT 'evento ' || e.id AS id FROM public.outbox_events e
  LEFT JOIN public.notifications n ON n.event_id = e.id AND n.user_id = e.recipient_user_id
  WHERE (e.status = 'processed') <> (n.id IS NOT NULL) OR n.id IS NOT NULL AND n.kind <> e.event_type
  UNION SELECT 'aviso ' || n.public_id::text FROM public.notifications n JOIN public.outbox_events e ON e.id = n.event_id
  WHERE n.user_id <> e.recipient_user_id ORDER BY 1`

/** Secuencias de las columnas de public con su próximo valor y el máximo de la columna. */
const SEQUENCES = `SELECT s.relname AS sequence, c.relname AS table_name, a.attname AS column_name
  FROM pg_class s JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid AND d.refclassid = 'pg_class'::regclass
    AND d.deptype IN ('a', 'i')
  JOIN pg_class c ON c.oid = d.refobjid JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.refobjsubid
  WHERE s.relkind = 'S' AND s.relnamespace = 'public'::regnamespace ORDER BY 1`

/** Conversación con secuencia 1..n sin huecos (la unicidad la da el esquema). */
const CHAT = `SELECT c.public_id::text AS id FROM public.chat_messages m JOIN public.commitments c ON c.id = m.commitment_id
  GROUP BY c.public_id HAVING max(m.sequence) <> count(*) ORDER BY 1`

function check(name, offending, detail = '') {
  return { name, ok: offending.length === 0, failures: offending.length, sample: offending.slice(0, SAMPLE), detail }
}

/**
 * Compara la base y los objetos restaurados con el manifiesto. `client` es la base
 * restaurada, `objects` viene de localObjects o storeObjects y `pickupKey` es la
 * PICKUP_CODE_KEY de la fuente (Buffer) o null. Solo lee, en una transacción de solo lectura.
 */
export async function reconcile({ client, manifest, objects, pickupKey }) {
  const rows = async sql => (await client.query(sql)).rows.map(row => row.id)
  const checks = []
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await client.query(`SET LOCAL lock_timeout = '${LOCK_WAIT}'`)
    const target = await describeDatabase(client)

    // Versión compatible: el servidor de destino no es más antiguo y PostGIS coincide en mayor.
    const versionProblems = []
    if (target.serverMajor < manifest.source.serverMajor) versionProblems.push(`PostgreSQL ${target.serverMajor} < ${manifest.source.serverMajor}`)
    if (manifest.source.postgis && target.postgis?.split('.')[0] !== manifest.source.postgis.split('.')[0]) {
      versionProblems.push(`PostGIS ${target.postgis} frente a ${manifest.source.postgis}`)
    }
    checks.push(check('versión de PostgreSQL y PostGIS', versionProblems,
      `fuente ${manifest.source.serverVersion} / PostGIS ${manifest.source.postgis}; destino ${target.serverVersion} / PostGIS ${target.postgis}`))

    // Migraciones: la base restaurada tiene las de la fuente y son las del repositorio.
    const repository = await repositoryMigrations()
    const migrationProblems = []
    if (!isDeepStrictEqual(target.migrations, manifest.source.migrations)) migrationProblems.push('pgmigrations distinto del manifiesto')
    const unknown = target.migrations.filter(name => !repository.includes(name))
    if (unknown.length) migrationProblems.push(...unknown.map(name => `desconocida en este checkout: ${name}`))
    else if (!isDeepStrictEqual(target.migrations, repository.slice(0, target.migrations.length))) migrationProblems.push('orden distinto del repositorio')
    else if (target.migrations.length < repository.length) {
      migrationProblems.push(...repository.slice(target.migrations.length).map(name => `pendiente: ${name}`))
    }
    checks.push(check('migraciones iguales al repositorio', migrationProblems,
      `${target.migrations.length} aplicadas, última ${target.migrations.at(-1) ?? 'ninguna'}; repositorio ${repository.length}`))

    // Conteos por tabla y agregados del manifiesto.
    const countProblems = []
    for (const table of new Set([...Object.keys(manifest.counts), ...Object.keys(target.counts)])) {
      if (manifest.counts[table] !== target.counts[table]) countProblems.push(`${table}: ${target.counts[table] ?? 'sin tabla'} ≠ ${manifest.counts[table] ?? 'sin tabla'}`)
    }
    for (const key of new Set([...Object.keys(manifest.aggregates), ...Object.keys(target.aggregates)])) {
      if (!isDeepStrictEqual(manifest.aggregates[key], target.aggregates[key])) countProblems.push(`${key} distinto`)
    }
    checks.push(check('conteos y agregados iguales al manifiesto', countProblems, `${Object.keys(target.counts).length} tablas`))

    // Esquema: restricciones, índices, funciones, disparadores, enums, colaciones y columnas.
    const schemaProblems = Object.keys({ ...manifest.schema, ...target.schema })
      .filter(part => !isDeepStrictEqual(manifest.schema[part], target.schema[part]))
      .map(part => `${part}: ${target.schema[part]?.count ?? 'sin datos'} definiciones, distinto del manifiesto (${manifest.schema[part]?.count ?? 'sin datos'})`)
    checks.push(check('esquema igual al manifiesto', schemaProblems,
      Object.entries(target.schema).map(([part, value]) => `${value.count} ${part}`).join(', ')))

    // Secuencias: el próximo valor supera el máximo de su columna, o el próximo INSERT choca.
    const sequenceProblems = []
    const sequences = (await client.query(SEQUENCES)).rows
    for (const item of sequences) {
      const { rows: [state] } = await client.query(`SELECT s.last_value::numeric AS last_value, s.is_called, q.increment_by::numeric AS increment,
          (SELECT max(${pg.escapeIdentifier(item.column_name)})::numeric FROM public.${pg.escapeIdentifier(item.table_name)}) AS max
        FROM public.${pg.escapeIdentifier(item.sequence)} s, pg_sequences q WHERE q.schemaname = 'public' AND q.sequencename = $1`, [item.sequence])
      const next = Number(state.last_value) + (state.is_called ? Number(state.increment) : 0)
      if (state.max !== null && next <= Number(state.max)) sequenceProblems.push(`${item.table_name}.${item.column_name}: próximo ${next} ≤ máximo ${state.max}`)
    }
    checks.push(check('secuencias de identificadores', sequenceProblems, `${sequences.length} secuencias`))

    checks.push(check('inventario de lotes (Q = F + O + R + E + X; R, O, E con sus registros; lote cerrado sin F, O, R ni cola)',
      await rows(INVENTORY), `${target.counts.lots} lotes`))
    checks.push(check('una entrega por compromiso entregado', await rows(DELIVERIES), `${target.counts.deliveries} entregas`))

    // Códigos: estado, huella única y descifrado con la clave correcta y con otra.
    const codeProblems = [...await rows(CODE_STATE), ...(await rows(DUPLICATED_FINGERPRINTS)).map(id => `huella repetida en ${id}`)]
    const codes = (await client.query(`SELECT public_id::text AS id, pickup_code_ciphertext AS ciphertext,
      pickup_code_fingerprint AS fingerprint FROM public.commitments WHERE pickup_code_ciphertext IS NOT NULL ORDER BY id`)).rows
    let codeDetail = `${codes.length} códigos vigentes`
    if (codes.length && !pickupKey) codeProblems.push('falta K053_PICKUP_CODE_KEY para descifrar')
    else if (codes.length) {
      const right = createPickupCodes(pickupKey)
      const wrong = createPickupCodes(randomBytes(32))
      let opened = 0
      let rejected = 0
      for (const code of codes) {
        try {
          const plain = right.reveal(code.ciphertext)
          if (Buffer.compare(Buffer.from(right.fingerprint(plain)), code.fingerprint) === 0) opened++
          else codeProblems.push(`huella no corresponde ${code.id}`)
        } catch { codeProblems.push(`no descifra ${code.id}`) }
        try { wrong.reveal(code.ciphertext); codeProblems.push(`descifra con otra clave ${code.id}`) } catch { rejected++ }
      }
      codeDetail += `; ${opened} descifrados con la clave de la fuente, ${rejected} rechazados con otra clave`
    }
    checks.push(check('códigos de retiro', codeProblems, codeDetail))

    checks.push(check('incidencias y sus versiones', await rows(INCIDENTS), `${target.counts.incidents} incidencias, ${target.counts.incident_versions} versiones`))
    checks.push(check('destinatarios con su evento de aviso', await rows(RECIPIENTS), `${target.counts.incident_recipients} destinatarios`))
    checks.push(check('outbox y avisos', await rows(OUTBOX), `${target.counts.outbox_events} eventos, ${target.counts.notifications} avisos`))
    checks.push(check('mensajes del chat en secuencia', await rows(CHAT), `${target.counts.chat_messages} mensajes`))

    // Fotos listas frente a objetos restaurados con su sha256 del manifiesto.
    const expected = await readyPhotoKeys(client)
    const byKey = new Map(manifest.photos.objects.map(object => [object.key, object]))
    const sourceMissing = new Set(manifest.photos.missing.map(item => item.key))
    const photoProblems = []
    let found = 0
    for (const { key } of expected) {
      if (sourceMissing.has(key)) { photoProblems.push(`faltaba en la fuente: ${key}`); continue }
      const object = byKey.get(key)
      if (!object) { photoProblems.push(`sin entrada en el manifiesto: ${key}`); continue }
      const bytes = await objects.read(key)
      if (!bytes) { photoProblems.push(`no restaurado: ${key}`); continue }
      found++
      if (sha256(bytes) !== object.sha256 || bytes.length !== object.bytes) photoProblems.push(`sha256 distinto: ${key}`)
    }
    let extra = 'sin listado del bucket: no se buscan objetos sobrantes'
    if (objects.list) {
      const referenced = new Set(expected.map(item => item.key))
      const present = await objects.list()
      for (const key of present) if (!referenced.has(key)) photoProblems.push(`objeto sin foto lista: ${key}`)
      extra = `${present.length} objetos en el destino`
    }
    checks.push(check('fotos listas con sus objetos', photoProblems,
      `${expected.length / 2} fotos listas, ${found} objetos encontrados, ${extra}, ${sourceMissing.size} faltantes en la fuente`))
  } finally {
    await client.query('ROLLBACK').catch(() => {})
  }
  return { passed: checks.every(item => item.ok), checks }
}

export function printReconciliation(result) {
  for (const item of result.checks) {
    console.log(`${item.ok ? 'OK  ' : 'FAIL'} ${item.name}: ${item.detail}${item.ok ? '' : ` · ${item.failures} con problema: ${item.sample.join('; ')}`}`)
  }
}
