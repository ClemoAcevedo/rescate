// RNF08: instantánea consistente, cifrado autenticado y publicación fuera del servidor.
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readPhotoStorage } from '../dist/composition.js'
import { createBackup, remoteDatabase } from './support/backup.mjs'
import { BACKUP_PREFIX, backupKey, backupStore, readJson, encryptBackup, uploadBackup, rotateBackups, writeJson } from './support/encrypted-backups.mjs'
import { rotateRecoveryJournal } from './support/recovery-journal.mjs'

let store
let work
let previous
let lock
let stage = 'configuration'
const at = new Date().toISOString()
try {
  const key = backupKey()
  store = backupStore()
  previous = await readJson(store, `${BACKUP_PREFIX}status.json`)
  const source = await remoteDatabase(process.env.K053_SOURCE_DATABASE_URL ?? process.env.DATABASE_URL, 'DATABASE_URL')
  stage = 'lock'
  lock = source.client()
  await lock.connect()
  const acquired = (await lock.query('SELECT pg_try_advisory_lock(107131,205) AS acquired')).rows[0].acquired
  if (!acquired) { console.log(JSON.stringify({ event: 'backup_already_running' })); process.exit(0) }
  await writeJson(store, `${BACKUP_PREFIX}status.json`, { lastAttempt: at, lastSuccess: previous?.lastSuccess ?? null, state: 'running' })
  const objects = readPhotoStorage(process.env)
  if (!objects) throw new Error('Falta almacenamiento de fotos')
  work = await mkdtemp(join(tmpdir(), 'rescate-backup-'))
  stage = 'snapshot'
  const manifest = await createBackup({ source, objects, storage: process.env.PHOTO_STORAGE, directory: join(work, 'plain') })
  const archive = join(work, 'backup.tar.enc')
  stage = 'encryption'
  await encryptBackup(join(work, 'plain'), archive, key)
  stage = 'upload'
  const metadata = await uploadBackup(store, archive, manifest, createHash('sha256').update(key).digest('hex').slice(0, 16))
  // Solo después de comprobar la copia subida se pueden quitar copias antiguas.
  stage = 'retention'
  const retention = await rotateBackups(store)
  const scope = process.env.RECOVERY_JOURNAL_SCOPE ?? process.env.RAILWAY_ENVIRONMENT_ID
  if (scope) await rotateRecoveryJournal(store, scope, retention.kept)
  stage = 'status'
  await writeJson(store, `${BACKUP_PREFIX}status.json`, { state: 'ok', lastAttempt: at, lastSuccess: metadata,
    retainedDays: retention.kept.length, completedAt: new Date().toISOString() })
  console.log(JSON.stringify({ event: 'backup_complete', createdAt: manifest.createdAt, sha256: metadata.sha256,
    bytes: metadata.bytes, retainedDays: retention.kept.length, missingPhotos: 0 }))
} catch {
  // Los errores de PostgreSQL/S3 pueden incluir credenciales, rutas o datos del origen.
  if (store) await writeJson(store, `${BACKUP_PREFIX}status.json`, { state: 'failed', lastAttempt: at,
    lastSuccess: previous?.lastSuccess ?? null, code: 'BACKUP_FAILED', stage }).catch(() => {})
  console.error(JSON.stringify({ event: 'backup_failed', code: 'BACKUP_FAILED', stage }))
  process.exitCode = 1
} finally {
  if (work) await rm(work, { recursive: true, force: true })
  store?.close()
  await lock?.end().catch(() => {})
}
