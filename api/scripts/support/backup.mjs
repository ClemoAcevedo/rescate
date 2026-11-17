// K053 · Copia y restauración de PostgreSQL y fotos (RNF08, anexos I p. 27). Funciones que
// comparten backup-create, backup-restore y backup-rehearsal. Nunca imprimen URLs, claves
// ni el error original de un proceso: pueden contener credenciales.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

export const root = fileURLToPath(new URL('../../../', import.meta.url))
export const apiDirectory = fileURLToPath(new URL('../../', import.meta.url))
export const resultsDirectory = join(apiDirectory, '.k053-results')
// Misma imagen que el servicio db de Compose y que PostGIS en Railway.
export const POSTGRES_IMAGE = 'postgis/postgis:16-3.5'
export const CLIENT_MAJOR = 16
export const RPO_HOURS = 24
export const RTO_MINUTES = 60
// Una copia que espera un bloqueo (por ejemplo, una migración del pre-deploy) falla en
// lugar de dejar la tabla bloqueada detrás de ella.
export const LOCK_WAIT = '10s'
// Solo las claves que deriva Domain (photoObjectKeys); los originales de uploads/ no se copian.
const OBJECT_KEY = /^photos\/[0-9a-f-]{36}\/(display|thumbnail)\.webp$/

export const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const elapsed = started => Math.round(performance.now() - started)

export async function sha256File(path) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length }
  return { sha256: hash.digest('hex'), bytes }
}

export function repositoryState() {
  if (process.env.BACKUP_TOOL_SHA) {
    if (!/^[a-f0-9]{40}$/.test(process.env.BACKUP_TOOL_SHA)) throw new Error('BACKUP_TOOL_SHA debe identificar el commit completo de la herramienta')
    return { commit: process.env.BACKUP_TOOL_SHA, dirty: process.env.BACKUP_TOOL_DIRTY === '1' }
  }
  return { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0 }
}

/** Nombres de las migraciones de un commit, o del árbol de trabajo sin `ref`. */
export async function repositoryMigrations(ref = null) {
  const files = ref
    ? git('ls-tree', '--name-only', `${ref}:api/migrations`).split('\n')
    : await readdir(join(apiDirectory, 'migrations'))
  return files.filter(file => file.endsWith('.sql')).map(file => file.slice(0, -4)).sort()
}

/** Pasos con su duración; `run` mide aunque el paso falle. */
export function timer() {
  const steps = []
  return {
    steps,
    async run(name, operation) {
      const started = performance.now()
      try { return await operation() } finally {
        steps.push({ step: name, ms: elapsed(started) })
        console.log(`  ${name}: ${(steps.at(-1).ms / 1000).toFixed(1)} s`)
      }
    },
  }
}

/**
 * Limpieza ante Ctrl-C o SIGTERM: bases, worktrees y procesos hijos registrados. Las
 * tareas son síncronas porque el proceso termina al volver del manejador.
 */
const interruptTasks = new Set()
export function onInterrupt(task) {
  interruptTasks.add(task)
  return () => interruptTasks.delete(task)
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.error(`\nInterrumpido por ${signal}: limpiando`)
    for (const task of [...interruptTasks].reverse()) { try { task() } catch { /* sigue con las demás */ } }
    process.exit(130)
  })
}

/** PICKUP_CODE_KEY en base64 canónico de 32 bytes o más, o null si falta. */
export function readPickupKey(encoded = process.env.K053_PICKUP_CODE_KEY) {
  if (!encoded) return null
  const key = Buffer.from(encoded, 'base64')
  if (key.length < 32 || key.toString('base64') !== encoded) throw new Error('K053_PICKUP_CODE_KEY no es base64 canónico de 32 bytes o más')
  return key
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const ENCRYPTED = new Set(['require', 'verify-ca', 'verify-full'])
const SSL_MODES = new Set(['disable', 'allow', 'prefer', ...ENCRYPTED])
const URL_PARAMETERS = new Set(['sslmode', 'sslrootcert', 'connect_timeout', 'application_name'])

/**
 * Conexión a una base fuera del Compose (la fuente de la copia o el destino que se
 * concilia). Fuera de este equipo exige sslmode=require, verify-ca o verify-full, salvo
 * K053_ALLOW_PLAINTEXT=1. El cliente pg recibe la configuración TLS explícita, con la
 * misma semántica que libpq, para que Node y pg_dump cifren igual.
 */
export async function remoteDatabase(text, name) {
  let url
  try { url = new URL(text) } catch { throw new Error(`${name} no es una URL postgresql://`) }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`${name} no es una URL postgresql://`)
  for (const key of url.searchParams.keys()) if (!URL_PARAMETERS.has(key)) throw new Error(`${name}: parámetro no admitido ${key}`)
  const sslmode = url.searchParams.get('sslmode')
  if (sslmode !== null && !SSL_MODES.has(sslmode)) throw new Error(`${name}: sslmode no admitido ${sslmode}`)
  const loopback = LOOPBACK.has(url.hostname)
  const encrypted = ENCRYPTED.has(sslmode)
  if (!loopback && !encrypted && process.env.K053_ALLOW_PLAINTEXT !== '1') {
    throw new Error(`${name} apunta fuera de este equipo sin sslmode=require, verify-ca o verify-full. `
      + 'K053_ALLOW_PLAINTEXT=1 acepta enviar los datos sin cifrar')
  }
  const rootCertPath = url.searchParams.get('sslrootcert')
  if (sslmode?.startsWith('verify-') && !rootCertPath) throw new Error(`${name}: sslmode=${sslmode} requiere sslrootcert`)
  const ca = rootCertPath ? await readFile(rootCertPath, 'utf8') : undefined
  const ssl = !encrypted ? false
    : sslmode === 'require' ? { rejectUnauthorized: false }
      : sslmode === 'verify-ca' ? { ca, checkServerIdentity: () => undefined } : { ca }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = Number(url.port || 5432)
  const user = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  const database = decodeURIComponent(url.pathname.slice(1)) || user
  const connectTimeout = Number(url.searchParams.get('connect_timeout') ?? 10)
  return {
    loopback, host, port, user, password, database, sslmode, rootCertPath, connectTimeout,
    client: (options = {}) => new pg.Client({ host, port, user, password: password || undefined, database, ssl,
      connectionTimeoutMillis: connectTimeout * 1000, application_name: 'rescate-k053', ...options }),
  }
}

/**
 * Servicio db de Compose. Las credenciales quedan solo en memoria. Las bases que crea
 * llevan el prefijo rescate_k053_, y solo esas se pueden borrar.
 */
export function composeDatabase() {
  const docker = (args, options = {}) => execFileSync('docker', ['compose', ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
  })
  const user = docker(['exec', '-T', 'db', 'printenv', 'POSTGRES_USER']).trim()
  const password = docker(['exec', '-T', 'db', 'printenv', 'POSTGRES_PASSWORD']).trim()
  const address = docker(['port', 'db', '5432']).trim()
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Se requiere el puerto loopback del servicio db de Compose')
  const name = kind => `rescate_k053_${kind}_${Date.now()}_${randomBytes(4).toString('hex')}`
  const own = database => {
    if (!/^rescate_k053_[a-z]+_\d+_[0-9a-f]{8}$/.test(database)) throw new Error(`Base ajena a K053: ${database}`)
    return database
  }
  return {
    user,
    url(database) {
      const url = new URL(`postgresql://${address}/${database}`)
      url.username = user
      url.password = password
      return url.href
    },
    /**
     * Base vacía desde template0: no hereda PostGIS ni objetos de desarrollo. Con
     * template_postgis tiene las extensiones que 10_postgis.sh crea en POSTGRES_DB, igual
     * que la base de producción.
     */
    create(kind, template = 'template0') {
      const database = name(kind)
      docker(['exec', '-T', 'db', 'createdb', '-U', user, `--template=${template}`, database])
      return database
    },
    /** Copia exacta de otra base K053 para ensayar fallas sin tocar la restaurada. */
    clone(source, kind) {
      const database = name(kind)
      // Una conexión recién cerrada puede seguir abierta un instante y bloquear la plantilla.
      for (let attempt = 1; ; attempt++) {
        try {
          docker(['exec', '-T', 'db', 'createdb', '-U', user, `--template=${own(source)}`, database])
          return database
        } catch (error) {
          if (attempt === 5) throw error
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
        }
      }
    },
    drop(database) {
      docker(['exec', '-T', 'db', 'dropdb', '-U', user, '--if-exists', '--force', own(database)])
    },
    /** pg_restore dentro del contenedor, leyendo el volcado por stdin. */
    async restore(database, dumpFile) {
      const child = spawn('docker', ['compose', 'exec', '-T', 'db', 'pg_restore', '-U', user, '-d', own(database),
        '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction'], { cwd: root, stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += chunk })
      createReadStream(dumpFile).pipe(child.stdin)
      const [code] = await once(child, 'close')
      // El mensaje de pg_restore no lleva URL: la conexión es local al contenedor.
      if (code !== 0) throw new Error(`pg_restore terminó con ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`)
    },
  }
}

/**
 * pg_dump -Fc con el cliente de la imagen de PostgreSQL 16. Host, usuario y base viajan
 * como variables PG* del contenedor; la contraseña, en un PGPASSFILE temporal de modo 0600
 * montado solo para este proceso. Ni la URL ni la contraseña quedan en argumentos ni en
 * `docker inspect`. Una fuente en el loopback se alcanza por host.docker.internal
 * (Docker Desktop, OrbStack) o con la red del equipo (Linux).
 */
export async function dumpDatabase(connection, snapshot, target) {
  const work = await mkdtemp(join(tmpdir(), 'rescate-k053-pg-'))
  const removeWork = onInterrupt(() => execFileSync('rm', ['-rf', work]))
  try {
    const escape = value => value.replace(/[\\:]/g, character => `\\${character}`)
    await writeFile(join(work, 'pgpass'), `*:*:*:*:${escape(connection.password)}\n`, { mode: 0o600 })
    const linux = process.platform === 'linux'
    const native = process.env.BACKUP_PG_TOOLS === 'native'
    if (native && !/^pg_dump \(PostgreSQL\) 16\./.test(execFileSync('pg_dump', ['--version'], { encoding: 'utf8' }))) throw new Error('La copia requiere pg_dump 16')
    const env = {
      PGHOST: connection.loopback && !linux && !native ? 'host.docker.internal' : connection.host,
      PGPORT: String(connection.port), PGUSER: connection.user, PGDATABASE: connection.database,
      PGPASSFILE: native ? join(work, 'pgpass') : '/k053/pgpass', PGCONNECT_TIMEOUT: String(connection.connectTimeout), PGAPPNAME: 'rescate-k053',
      PGSSLMODE: connection.sslmode ?? (connection.loopback ? 'disable' : 'prefer'),
    }
    if (connection.rootCertPath) {
      await copyFile(connection.rootCertPath, join(work, 'root.crt'))
      env.PGSSLROOTCERT = native ? join(work, 'root.crt') : '/k053/root.crt'
    }
    const args = ['--format=custom', '--no-owner', '--no-privileges', `--lock-wait-timeout=${LOCK_WAIT}`, `--snapshot=${snapshot}`]
    const child = native ? spawn('pg_dump', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
      : spawn('docker', ['run', '--rm', '--platform', 'linux/amd64', ...(connection.loopback && linux ? ['--network', 'host'] : []),
      '-v', `${work}:/k053:ro`, ...Object.keys(env).flatMap(key => ['-e', key]), POSTGRES_IMAGE,
      'pg_dump', ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    const stopChild = onInterrupt(() => child.kill('SIGKILL'))
    const hash = createHash('sha256')
    let bytes = 0
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdout.on('data', chunk => { hash.update(chunk); bytes += chunk.length })
    const file = createWriteStream(target, { mode: 0o600, flags: 'wx' })
    child.stdout.pipe(file)
    const [[code]] = await Promise.all([once(child, 'close'), once(file, 'close')])
    stopChild()
    // Las dos últimas líneas; no llevan contraseña porque esta no pasa por argumentos.
    if (code !== 0) throw new Error(`pg_dump terminó con ${code}: ${stderr.trim().split('\n').slice(-2).join(' | ')}`)
    return { sha256: hash.digest('hex'), bytes }
  } finally {
    removeWork()
    await rm(work, { recursive: true, force: true })
  }
}

/** Excluye objetos de una extensión (PostGIS deja funciones y spatial_ref_sys en public). */
const notExtension = (catalog, column) => `NOT EXISTS (SELECT 1 FROM pg_depend x WHERE x.classid = '${catalog}'::regclass
  AND x.objid = ${column} AND x.deptype = 'e')`

/**
 * Definiciones del esquema public sin objetos de extensiones. Su sha256 por parte va en
 * el manifiesto: una restricción, índice, función, disparador, enum, colación o columna
 * que falte o cambie después de restaurar se detecta aunque los conteos coincidan.
 */
const SCHEMA_PARTS = {
  columns: `SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
      || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
      || CASE WHEN a.attidentity::text <> '' THEN ' identity ' || a.attidentity::text ELSE '' END
      || CASE WHEN a.attgenerated::text <> '' THEN ' generated' ELSE '' END
      || coalesce(' collate ' || (SELECT collname FROM pg_collation WHERE oid = a.attcollation AND collname <> 'default'), '') AS def
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
      AND ${notExtension('pg_class', 'c.oid')}`,
  constraints: `SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace AND ${notExtension('pg_class', 'conrelid')}`,
  indexes: `SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relnamespace = 'public'::regnamespace AND ${notExtension('pg_class', 'i.indrelid')}`,
  functions: `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND ${notExtension('pg_proc', 'p.oid')}`,
  triggers: `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND ${notExtension('pg_class', 'c.oid')}`,
  views: `SELECT c.relname || ' ' || pg_get_viewdef(c.oid) AS def FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm') AND ${notExtension('pg_class', 'c.oid')}`,
  enums: `SELECT t.typname || ' ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS def FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typnamespace = 'public'::regnamespace AND ${notExtension('pg_type', 't.oid')}
    GROUP BY t.typname`,
  collations: `SELECT (to_jsonb(c) - ARRAY['oid', 'collnamespace', 'collowner', 'collversion'])::text AS def FROM pg_collation c
    WHERE c.collnamespace = 'public'::regnamespace AND ${notExtension('pg_collation', 'c.oid')}`,
  sequences: `SELECT s.sequencename || ' ' || s.data_type || ' ' || s.increment_by AS def FROM pg_sequences s
    WHERE s.schemaname = 'public'`,
}

export async function describeSchema(client) {
  const parts = {}
  for (const [part, sql] of Object.entries(SCHEMA_PARTS)) {
    // PostgreSQL no vuelve a escribir igual una expresión restaurada: `a AND (b AND c)` pasa
    // a `a AND b AND c`. Sin paréntesis ni espacios la huella sobrevive a pg_restore.
    const definitions = (await client.query(sql)).rows.map(row => row.def.replace(/[()\s]/g, '')).sort()
    parts[part] = { count: definitions.length, sha256: sha256(definitions.join('\n')) }
  }
  return parts
}

/** Versión, extensiones, migraciones, conteos y agregados, leídos dentro de una transacción. */
export async function describeDatabase(client) {
  const one = async sql => (await client.query(sql)).rows[0]
  const { server_version: serverVersion, server_version_num: versionNum } = await one(
    "SELECT current_setting('server_version') AS server_version, current_setting('server_version_num')::int AS server_version_num")
  const extensions = (await client.query('SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname')).rows
  const postgis = extensions.some(extension => extension.name === 'postgis') ? (await one('SELECT postgis_lib_version() AS v')).v : null
  const hasMigrations = (await one("SELECT to_regclass('public.pgmigrations') IS NOT NULL AS present")).present
  const migrations = hasMigrations ? (await client.query('SELECT name FROM public.pgmigrations ORDER BY id')).rows.map(row => row.name) : []
  // Tablas propias del esquema public; las de una extensión (spatial_ref_sys) no cuentan.
  const tables = (await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    ORDER BY c.relname`)).rows.map(row => row.relname)
  const counts = {}
  for (const table of tables) counts[table] = Number((await one(`SELECT count(*) AS n FROM public.${pg.escapeIdentifier(table)}`)).n)
  const grouped = async sql => Object.fromEntries((await client.query(sql)).rows.map(row => [row.k, Number(row.n)]))
  const aggregates = counts.lots === undefined ? {} : {
    lotsByStatus: await grouped('SELECT status::text AS k, count(*) AS n FROM public.lots GROUP BY 1 ORDER BY 1'),
    lotCounters: Object.fromEntries(Object.entries(await one(`SELECT coalesce(sum(quantity), 0) AS q, coalesce(sum(free_quantity), 0) AS f,
      coalesce(sum(offered_quantity), 0) AS o, coalesce(sum(reserved_quantity), 0) AS r, coalesce(sum(delivered_quantity), 0) AS e,
      coalesce(sum(expired_quantity), 0) AS x FROM public.lots`)).map(([key, value]) => [key, Number(value)])),
    commitmentsByStatus: await grouped('SELECT status AS k, count(*) AS n FROM public.commitments GROUP BY 1 ORDER BY 1'),
    pickupCodes: Number((await one('SELECT count(*) AS n FROM public.commitments WHERE pickup_code_ciphertext IS NOT NULL')).n),
    deliveredPacks: Number((await one('SELECT coalesce(sum(quantity), 0) AS n FROM public.deliveries')).n),
    photosByStatus: await grouped('SELECT status AS k, count(*) AS n FROM public.lot_photos GROUP BY 1 ORDER BY 1'),
    ...(counts.incidents === undefined ? {} : {
      incidentsByStatus: await grouped('SELECT status::text AS k, count(*) AS n FROM public.incidents GROUP BY 1 ORDER BY 1'),
    }),
    outboxByStatus: await grouped('SELECT status AS k, count(*) AS n FROM public.outbox_events GROUP BY 1 ORDER BY 1'),
  }
  const schema = await describeSchema(client)
  return { serverVersion, serverMajor: Math.floor(versionNum / 10000), postgis, extensions, migrations, counts, aggregates, schema }
}

/** Fotos listas: las únicas con objetos finales que deben existir. */
export async function readyPhotoKeys(client) {
  const rows = (await client.query("SELECT public_id::text AS id FROM public.lot_photos WHERE status = 'ready' ORDER BY id")).rows
  return rows.flatMap(row => [`photos/${row.id}/display.webp`, `photos/${row.id}/thumbnail.webp`].map(key => ({ photoId: row.id, key })))
}

/**
 * Crea la copia en `directory`, que debe no existir o estar vacío: database.dump,
 * objects/lot-photos/<clave> y, al final, manifest.json. Volcado, conteos y lista de fotos
 * salen de la misma instantánea de una transacción REPEATABLE READ de solo lectura, así
 * que describen el mismo estado. `source` viene de remoteDatabase.
 */
export async function createBackup({ source: connection, objects, storage, directory }) {
  const clock = timer()
  const started = performance.now()
  const entries = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  if (entries.length) throw new Error(`${directory} no está vacío: cada copia va en una carpeta nueva`)
  await mkdir(join(directory, 'objects', 'lot-photos'), { recursive: true, mode: 0o700 })
  const client = connection.client({ options: '-c default_transaction_read_only=on' })
  await client.connect()
  let manifest
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    // Los conteos toman ACCESS SHARE: si una migración espera, la copia falla y la suelta.
    await client.query(`SET LOCAL lock_timeout = '${LOCK_WAIT}'`)
    const { snapshot, at, database } = (await client.query(
      'SELECT pg_export_snapshot() AS snapshot, now() AS at, current_database() AS database')).rows[0]
    const source = await clock.run('describir la fuente', () => describeDatabase(client))
    if (source.serverMajor > CLIENT_MAJOR) throw new Error(`La fuente es PostgreSQL ${source.serverMajor}; pg_dump ${CLIENT_MAJOR} no puede volcarla`)
    const keys = await readyPhotoKeys(client)
    const dump = await clock.run('pg_dump', () => dumpDatabase(connection, snapshot, join(directory, 'database.dump')))
    await client.query('COMMIT')
    const copied = []
    const missing = []
    await clock.run('copiar fotos', async () => {
      // Pocas lecturas a la vez: el bucket limita transacciones y la copia no apura al servicio.
      let next = 0
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < keys.length) {
          const item = keys[next++]
          const bytes = await objects.get(item.key)
          if (!bytes) { missing.push(item); continue }
          const target = join(directory, 'objects', 'lot-photos', item.key)
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await writeFile(target, bytes, { mode: 0o600 })
          copied.push({ key: item.key, bytes: bytes.length, sha256: sha256(bytes) })
        }
      }))
    })
    const tool = repositoryState()
    manifest = {
      card: 'K053', format: 1, createdAt: new Date(at).toISOString(),
      tool: { ...tool, node: process.version, image: POSTGRES_IMAGE, repositoryMigrations: await repositoryMigrations() },
      source: { database, serverVersion: source.serverVersion, serverMajor: source.serverMajor, postgis: source.postgis,
        extensions: source.extensions, migrations: source.migrations, lastMigration: source.migrations.at(-1) ?? null },
      database: { file: 'database.dump', format: 'custom', ...dump },
      counts: source.counts, aggregates: source.aggregates, schema: source.schema,
      photos: { storage, readyPhotos: keys.length / 2, objects: copied.sort((a, b) => a.key.localeCompare(b.key)),
        missing: missing.sort((a, b) => a.key.localeCompare(b.key)) },
      durations: { steps: clock.steps, totalMs: elapsed(started) },
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await client.end().catch(() => {})
  }
  // El manifiesto se escribe al final y por renombre: su presencia marca una copia completa.
  const temporary = join(directory, 'manifest.json.tmp')
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, join(directory, 'manifest.json'))
  return manifest
}

/**
 * Lee manifest.json. Con `expectedSha256` (el registrado al guardar la copia) rechaza un
 * manifiesto editado: el manifiesto no lleva hash propio.
 */
export async function readManifest(directory, expectedSha256 = null) {
  const bytes = await readFile(join(directory, 'manifest.json'))
  if (expectedSha256 && sha256(bytes) !== expectedSha256.toLowerCase()) throw new Error('manifest.json no coincide con el sha256 registrado')
  const manifest = JSON.parse(bytes.toString('utf8'))
  if (manifest.card !== 'K053' || manifest.format !== 1 || !manifest.schema) throw new Error('manifest.json no es una copia K053 formato 1')
  for (const object of manifest.photos.objects) if (!OBJECT_KEY.test(object.key)) throw new Error(`Clave no permitida en el manifiesto: ${object.key}`)
  return manifest
}

/** Volcado y objetos de la copia contra el manifiesto, antes de restaurar nada. */
export async function verifyBackup(directory, manifest) {
  const problems = []
  const dump = await sha256File(join(directory, manifest.database.file)).catch(() => null)
  if (!dump || dump.sha256 !== manifest.database.sha256 || dump.bytes !== manifest.database.bytes) problems.push(manifest.database.file)
  for (const object of manifest.photos.objects) {
    const actual = await sha256File(join(directory, 'objects', 'lot-photos', object.key)).catch(() => null)
    if (!actual || actual.sha256 !== object.sha256 || actual.bytes !== object.bytes) problems.push(object.key)
  }
  return problems
}

/** Copia los objetos verificados a `target`/lot-photos, el formato de PHOTO_STORAGE=local. */
export async function restoreObjects(directory, manifest, target) {
  for (const object of manifest.photos.objects) {
    const destination = join(target, 'lot-photos', object.key)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await copyFile(join(directory, 'objects', 'lot-photos', object.key), destination)
  }
}

/** Claves de los archivos bajo `target`/lot-photos. */
export async function listObjects(target) {
  const base = join(target, 'lot-photos')
  const entries = await readdir(base, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(base.length + 1)).sort()
}

/** Objetos que concilia reconcile: un directorio local, con listado de sobrantes. */
export function localObjects(photoRoot) {
  return {
    async read(key) { return readFile(join(photoRoot, 'lot-photos', key)).catch(error => { if (error.code === 'ENOENT') return null; throw error }) },
    list: () => listObjects(photoRoot),
  }
}

/** Objetos de un ObjectStore (bucket): sin listado, solo se buscan los que faltan. */
export function storeObjects(store) {
  return { read: key => store.get(key), list: null }
}

export async function exists(path) {
  return stat(path).then(() => true, () => false)
}
