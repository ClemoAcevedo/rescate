// K053 · Levanta una API (este checkout o el commit de un release anterior) contra la base
// restaurada y comprueba salud, lectura pública, una foto y la bandeja de avisos.
// La reversión de docs/despliegue.md vuelve al código anterior sin migraciones down.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { rmSync } from 'node:fs'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { apiDirectory, git, onInterrupt, repositoryMigrations } from './backup.mjs'

const ORIGIN = 'https://localhost:5173'
const SESSION_COOKIE = '__Host-rescate_session'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

/**
 * Release anterior por omisión: la penúltima etiqueta deploy-* alcanzable desde HEAD. La
 * última es el release vigente (o HEAD mismo, si es ese release).
 */
export function defaultPreviousRelease() {
  return git('tag', '--list', 'deploy-*', '--merged', 'HEAD', '--sort=-creatordate').split('\n').filter(Boolean)[1] ?? null
}

/** Commit de un release, validado antes de restaurar nada. */
export function resolveRelease(ref) {
  try { return git('rev-parse', '--verify', `${ref}^{commit}`) } catch { throw new Error(`No existe el commit o tag ${ref}`) }
}

/**
 * API compilada en `cwd`/dist con PHOTO_STORAGE=local sobre las fotos restauradas. La API
 * escucha en todas las interfaces (index.ts no recibe host) mientras dura la comprobación.
 */
export async function startApi({ cwd, databaseUrl, photoRoot, pickupKey }) {
  const port = await freePort()
  const child = spawn(process.execPath, ['dist/index.js'], { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: {
    PATH: process.env.PATH, PORT: String(port), DATABASE_URL: databaseUrl, RESCATE_ALLOWED_ORIGINS: ORIGIN,
    CSRF_SIGNING_KEY: randomBytes(32).toString('base64'), PICKUP_CODE_KEY: pickupKey.toString('base64'),
    PHOTO_STORAGE: 'local', PHOTO_LOCAL_DIR: photoRoot,
  } })
  const forget = onInterrupt(() => child.kill('SIGKILL'))
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const base = `http://127.0.0.1:${port}`
  const started = performance.now()
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break
    if (await fetch(`${base}/health`).then(response => response.ok, () => false)) {
      return { base, startMs: Math.round(performance.now() - started), stop: async () => {
        if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
        forget()
      } }
    }
    await sleep(200)
  }
  if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }
  forget()
  // La salida de la API no lleva la URL de la base (docs/seguridad.md); se recorta igual.
  throw new Error(`La API no respondió /health: ${stderr.trim().split('\n').at(-1)?.slice(0, 200) ?? 'sin salida'}`)
}

/**
 * Sesión para quien tiene un aviso de incidencia (o cualquier aviso). Escribe en sessions:
 * se usa sobre una copia de la base restaurada, nunca sobre la que se concilia.
 */
export async function seedReaderSession(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const { rows: [reader] } = await client.query(`SELECT user_id::text AS id, count(*) FILTER (WHERE kind = 'incident_version')::int AS incidents
      FROM public.notifications GROUP BY user_id ORDER BY 2 DESC, count(*) DESC LIMIT 1`)
    if (!reader) return null
    const secret = randomBytes(32)
    await client.query(`INSERT INTO public.sessions (user_id, token_hash, created_at, expires_at)
      VALUES ($1, $2, now(), now() + interval '12 hours')`, [reader.id, createHash('sha256').update(secret).digest()])
    return { cookie: `${SESSION_COOKIE}=${secret.toString('base64url')}`, incidentNotifications: reader.incidents }
  } finally {
    await client.end()
  }
}

/**
 * Worker compilado en `cwd`: debe dejar el latido sin worker_error mientras la API lo informa.
 * Sin almacenamiento de fotos, para que su limpieza no borre objetos restaurados.
 */
export async function workerCycle({ cwd, databaseUrl, base }) {
  const child = spawn(process.execPath, ['dist/worker.js'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, DATABASE_URL: databaseUrl, PHOTO_STORAGE: '' } })
  const forget = onInterrupt(() => child.kill('SIGKILL'))
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  try {
    let worker = 'unknown'
    for (let attempt = 0; attempt < 60 && worker !== 'ok' && child.exitCode === null; attempt++) {
      await sleep(500)
      worker = (await fetch(`${base}/health`).then(response => response.json(), () => null))?.worker ?? 'unknown'
    }
    // Deja pasar otra vuelta completa antes de revisar errores.
    if (worker === 'ok') await sleep(11_000)
    const errors = output.split('\n').filter(line => line.includes('worker_error') || line.includes('outbox_event_failed')).length
    return { name: 'worker: latido sin errores', ok: worker === 'ok' && errors === 0 && child.exitCode === null,
      detail: `/health worker=${worker}, ${errors} errores registrados` }
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
    forget()
  }
}

/**
 * Qué debe servir la API según la base: lotes en la búsqueda pública y una foto lista de
 * un lote publicado (se sirve sin sesión aunque el plazo haya terminado). Se lee de la
 * base para que la falta de datos no pase en silencio como una comprobación correcta.
 */
export async function smokeTargets(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl, options: '-c default_transaction_read_only=on' })
  await client.connect()
  try {
    const { rows: [row] } = await client.query(`SELECT
      (SELECT count(*)::int FROM public.lots WHERE status = 'published' AND paused_at IS NULL AND pickup_ends_at > now()) AS public_lots,
      (SELECT public_id::text FROM public.lots WHERE status = 'published' AND paused_at IS NULL AND pickup_ends_at > now()
        ORDER BY id LIMIT 1) AS public_lot,
      (SELECT l.public_id::text || ' ' || p.public_id::text FROM public.lot_photos p JOIN public.lots l ON l.id = p.lot_id
        WHERE p.status = 'ready' AND l.status = 'published' ORDER BY p.id LIMIT 1) AS photo`)
    const [photoLot, photoId] = row.photo?.split(' ') ?? []
    return { publicLots: row.public_lots, publicLot: row.public_lot, photo: photoId ? { lot: photoLot, id: photoId } : null }
  } finally {
    await client.end()
  }
}

/**
 * Salud, búsqueda y detalle públicos, una miniatura publicada y la bandeja de avisos.
 * Lo que la copia no permite comprobar (sin lotes vigentes o sin fotos publicadas) queda
 * como omitido y se informa, nunca como correcto sin más.
 */
export async function smoke(base, targets, session) {
  const checks = []
  const record = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok }
  const skip = (name, detail) => checks.push({ name, ok: true, skipped: true, detail })
  const health = await fetch(`${base}/health`)
  const healthBody = await health.json().catch(() => null)
  record('GET /health', health.status === 200 && healthBody?.database === 'ok', `${health.status} ${JSON.stringify(healthBody)}`)
  const search = await fetch(`${base}/public/lots`)
  const page = await search.json().catch(() => null)
  const listed = page?.items?.length ?? 0
  record('GET /public/lots', search.status === 200 && Array.isArray(page?.items) && (listed > 0) === (targets.publicLots > 0),
    `${search.status}, ${listed} lotes en la página; la base tiene ${targets.publicLots} vigentes`)
  if (targets.publicLot) {
    const detail = await fetch(`${base}/public/lots/${targets.publicLot}`)
    record('GET /public/lots/:id', detail.status === 200, String(detail.status))
  } else skip('GET /public/lots/:id', 'omitida: la copia no tiene lotes publicados vigentes')
  if (targets.photo) {
    const image = await fetch(`${base}/lots/${targets.photo.lot}/photos/${targets.photo.id}/thumbnail`)
    record('GET miniatura publicada', image.status === 200 && image.headers.get('content-type') === 'image/webp',
      `${image.status} ${image.headers.get('content-type')}`)
  } else skip('GET miniatura publicada', 'omitida: la copia no tiene fotos listas de lotes publicados')
  if (session) {
    const inbox = await fetch(`${base}/notifications`, { headers: { Cookie: session.cookie } })
    const body = await inbox.json().catch(() => null)
    const kinds = [...new Set(body?.items?.map(item => item.kind) ?? [])].sort().join(', ')
    record('GET /notifications', inbox.status === 200, `${inbox.status}, ${body?.items?.length ?? 0} avisos (${kinds || 'sin avisos'})`)
  }
  return checks
}

/**
 * Reversión al release anterior sin migraciones down: sus migraciones deben ser prefijo de
 * las restauradas, y su API y su worker, compilados en un worktree temporal, deben funcionar
 * sobre `databaseUrl`, que es una copia de la base restaurada. Con el mismo package-lock se
 * reutilizan las dependencias instaladas; si difiere, se instalan con npm ci.
 */
export async function checkPreviousRelease({ ref, commit, databaseUrl, photoRoot, pickupKey, restoredMigrations, session, targets }) {
  const previous = await repositoryMigrations(commit)
  const prefix = previous.every((name, index) => restoredMigrations[index] === name)
  const result = { ref, commit, previousMigrations: previous.length, restoredMigrations: restoredMigrations.length, prefix,
    newerMigrations: restoredMigrations.slice(previous.length), runtime: null }
  if (!prefix) return { ...result, ok: false, reason: 'Las migraciones del release anterior no son prefijo de las restauradas' }
  let sameLock = true
  try { execFileSync('git', ['diff', '--quiet', commit, 'HEAD', '--', 'api/package-lock.json'], { cwd: apiDirectory }) } catch { sameLock = false }

  const directory = await mkdtemp(join(tmpdir(), 'rescate-k053-release-'))
  const worktree = join(directory, 'tree')
  const cwd = join(worktree, 'api')
  const removeWorktree = () => {
    try { git('worktree', 'remove', '--force', worktree) } catch { /* se poda abajo */ }
    git('worktree', 'prune')
    rmSync(directory, { recursive: true, force: true })
  }
  const forget = onInterrupt(removeWorktree)
  let api
  try {
    git('worktree', 'add', '--detach', worktree, commit)
    const built = performance.now()
    if (sameLock) await symlink(join(apiDirectory, 'node_modules'), join(cwd, 'node_modules'), 'dir')
    else execFileSync('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], { cwd, stdio: 'ignore' })
    execFileSync(process.execPath, [join(cwd, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd, stdio: 'ignore' })
    const buildMs = Math.round(performance.now() - built)
    api = await startApi({ cwd, databaseUrl, photoRoot, pickupKey })
    const checks = await smoke(api.base, targets, session)
    checks.push(await workerCycle({ cwd, databaseUrl, base: api.base }))
    result.runtime = { dependencies: sameLock ? 'las del checkout (mismo package-lock)' : 'npm ci', buildMs, startMs: api.startMs, checks }
    return { ...result, ok: checks.every(item => item.ok) }
  } finally {
    await api?.stop()
    removeWorktree()
    forget()
  }
}
