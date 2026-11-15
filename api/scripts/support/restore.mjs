// K053 · Restauración en una base nueva del servicio db de Compose, objetos a un directorio
// local, conciliación y API levantada sobre lo restaurado. Mide cada paso y el total desde
// la intervención frente a la meta de 60 min y la antigüedad de la copia frente a 24 h.
// Después, sobre copias de la base, comprueba el worker actual y el release anterior.
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { apiDirectory, composeDatabase, elapsed, localObjects, onInterrupt, readManifest, restoreObjects, RPO_HOURS, RTO_MINUTES, timer, verifyBackup } from './backup.mjs'
import { printReconciliation, reconcile } from './reconcile.mjs'
import { checkPreviousRelease, resolveRelease, seedReaderSession, smoke, smokeTargets, startApi, workerCycle } from './release-check.mjs'

const mark = item => (item.skipped ? 'OMIT' : item.ok ? 'OK  ' : 'FAIL')

/**
 * `discard` borra la base restaurada y las fotos restauradas al terminar (o al fallar o
 * interrumpirse): una copia de producción no deja datos personales sin cifrar.
 */
export async function restoreAndVerify({ directory, pickupKey, previousRelease = null, interventionStarted = performance.now(),
  db = composeDatabase(), onDatabase = () => {}, manifestSha256 = null, discard = false }) {
  const clock = timer()
  // La API exige una clave para arrancar; sin la de la fuente solo fallan los códigos.
  const apiKey = pickupKey ?? randomBytes(32)
  // El release anterior se valida antes de restaurar: un tag inexistente no deja una base a medias.
  const previousCommit = previousRelease ? resolveRelease(previousRelease) : null
  const manifest = await readManifest(directory, manifestSha256)
  const report = { backup: directory, copyCreatedAt: manifest.createdAt, manifestSha256Checked: Boolean(manifestSha256), database: null, photoRoot: null }
  const removeRestored = async () => {
    if (report.database) db.drop(report.database)
    if (report.photoRoot) await rm(report.photoRoot, { recursive: true, force: true })
    report.discarded = true
  }
  let forgetDiscard = () => {}
  try {
    await clock.run('verificar la copia', async () => {
      const problems = await verifyBackup(directory, manifest)
      if (problems.length) throw new Error(`La copia no coincide con su manifiesto: ${problems.slice(0, 5).join(', ')}`)
    })
    report.database = await clock.run('crear base aislada', () => db.create('restore'))
    report.photoRoot = join(directory, `restore-${report.database}`)
    if (discard) forgetDiscard = onInterrupt(() => { db.drop(report.database); rmSync(report.photoRoot, { recursive: true, force: true }) })
    onDatabase(report.database)
    console.log(`  base restaurada: ${report.database}`)
    const databaseUrl = db.url(report.database)
    await clock.run('pg_restore', () => db.restore(report.database, join(directory, manifest.database.file)))
    await clock.run('restaurar fotos', () => restoreObjects(directory, manifest, report.photoRoot))
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      report.reconciliation = await clock.run('conciliar', () => reconcile({ client, manifest, objects: localObjects(report.photoRoot), pickupKey }))
    } finally {
      await client.end()
    }
    printReconciliation(report.reconciliation)
    const targets = await smokeTargets(databaseUrl)
    report.current = await clock.run('API actual sobre lo restaurado', async () => {
      const api = await startApi({ cwd: apiDirectory, databaseUrl, photoRoot: report.photoRoot, pickupKey: apiKey })
      try { return { startMs: api.startMs, checks: await smoke(api.base, targets) } } finally { await api.stop() }
    })
    const recoveredMs = elapsed(interventionStarted)
    const ageHours = (Date.now() - Date.parse(manifest.createdAt)) / 3_600_000
    const verified = report.reconciliation.passed && report.current.checks.every(item => item.ok)
    report.recovery = {
      steps: clock.steps, totalMs: recoveredMs, verified, rtoGoalMinutes: RTO_MINUTES,
      // Recuperado es restaurado, conciliado y con la API respondiendo; si no, no cumple.
      rtoMet: verified && recoveredMs <= RTO_MINUTES * 60_000,
      copyAgeHours: Math.round(ageHours * 1000) / 1000, rpoGoalHours: RPO_HOURS, rpoMet: ageHours <= RPO_HOURS,
    }
    for (const item of report.current.checks) console.log(`${mark(item)} API actual ${item.name}: ${item.detail}`)

    // Fuera de la medición y sobre copias: la sesión de lectura y los workers no tocan lo conciliado.
    const copy = await clock.run('copiar la base para el worker actual', () => db.clone(report.database, 'worker'))
    console.log(`  copia para el worker actual: ${copy}`)
    const forgetCopy = onInterrupt(() => db.drop(copy))
    try {
      const copyUrl = db.url(copy)
      const session = await seedReaderSession(copyUrl)
      report.currentWorker = await clock.run('worker y bandeja de la API actual', async () => {
        const api = await startApi({ cwd: apiDirectory, databaseUrl: copyUrl, photoRoot: report.photoRoot, pickupKey: apiKey })
        try {
          const checks = session ? (await smoke(api.base, targets, session)).filter(item => item.name === 'GET /notifications') : []
          checks.push(await workerCycle({ cwd: apiDirectory, databaseUrl: copyUrl, base: api.base }))
          return { checks }
        } finally { await api.stop() }
      })
    } finally {
      db.drop(copy)
      forgetCopy()
    }
    for (const item of report.currentWorker.checks) console.log(`${mark(item)} API actual ${item.name}: ${item.detail}`)

    if (previousCommit) {
      const release = await clock.run('copiar la base para la reversión', () => db.clone(report.database, 'release'))
      console.log(`  copia para el release anterior: ${release}`)
      const forgetRelease = onInterrupt(() => db.drop(release))
      try {
        const releaseUrl = db.url(release)
        const session = await seedReaderSession(releaseUrl)
        report.previous = await clock.run('API y worker del release anterior', () => checkPreviousRelease({ ref: previousRelease, commit: previousCommit,
          databaseUrl: releaseUrl, photoRoot: report.photoRoot, pickupKey: apiKey, restoredMigrations: manifest.source.migrations, session, targets }))
      } finally {
        db.drop(release)
        forgetRelease()
      }
      printPrevious(report.previous)
    }
    report.passed = verified && report.recovery.rtoMet && report.recovery.rpoMet
      && report.currentWorker.checks.every(item => item.ok) && (!report.previous || report.previous.ok)
  } finally {
    if (discard) { await removeRestored(); forgetDiscard() }
    await writeFile(join(directory, `restore-${report.database ?? 'sin-base'}.json`), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(() => {})
  }
  return report
}

function printPrevious(previous) {
  console.log(`${previous.prefix ? 'OK  ' : 'FAIL'} migraciones del release anterior ${previous.commit.slice(0, 7)}: ${previous.previousMigrations} `
    + `son prefijo de las ${previous.restoredMigrations} restauradas; posteriores: ${previous.newerMigrations.join(', ') || 'ninguna'}`)
  if (previous.reason) console.log(`     ${previous.reason}`)
  for (const item of previous.runtime?.checks ?? []) console.log(`${mark(item)} API anterior ${item.name}: ${item.detail}`)
}

export function printRecovery(report) {
  const { recovery } = report
  if (!recovery) return
  console.log(`Recuperación: ${(recovery.totalMs / 1000).toFixed(1)} s desde la intervención (meta ${recovery.rtoGoalMinutes} min: `
    + `${recovery.rtoMet ? 'cumple' : recovery.verified ? 'NO cumple' : 'NO cumple: la conciliación o la API fallaron'}); `
    + `copia de ${recovery.copyAgeHours.toFixed(2)} h (meta ${recovery.rpoGoalHours} h: ${recovery.rpoMet ? 'cumple' : 'NO cumple'})`)
}
