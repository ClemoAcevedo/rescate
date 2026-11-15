// K053 · Concilia una base ya restaurada fuera del Compose (por ejemplo, el PostgreSQL nuevo de
// producción tras una pérdida) y su almacenamiento de fotos contra el manifiesto de la copia.
// Solo lee: conexión con default_transaction_read_only y GetObject en el bucket.
//   K053_TARGET_DATABASE_URL     base restaurada; fuera de este equipo, con sslmode=require o verify-*
//   K053_TARGET_PHOTO_STORAGE    s3 (con las PHOTO_S3_* de la API) o local
//   K053_TARGET_PHOTO_DIR        con local: directorio que contiene lot-photos/
//   K053_PICKUP_CODE_KEY         PICKUP_CODE_KEY de la fuente
//   K053_ALLOW_PLAINTEXT=1       acepta un destino remoto sin TLS
// Uso: npm --prefix api run backup:reconcile -- <copia> [--manifiesto-sha256 <hex>]
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { readPhotoStorage } from '../dist/composition.js'
import { elapsed, localObjects, readManifest, readPickupKey, remoteDatabase, storeObjects } from './support/backup.mjs'
import { printReconciliation, reconcile } from './support/reconcile.mjs'

const started = performance.now()
const { positionals: [directory], values: options } = parseArgs({ allowPositionals: true, options: { 'manifiesto-sha256': { type: 'string' } } })
try {
  if (!directory) throw new Error('Uso: npm --prefix api run backup:reconcile -- <copia> [--manifiesto-sha256 <hex>]')
  if (!process.env.K053_TARGET_DATABASE_URL) throw new Error('Falta K053_TARGET_DATABASE_URL')
  const target = await remoteDatabase(process.env.K053_TARGET_DATABASE_URL, 'K053_TARGET_DATABASE_URL')
  const storage = process.env.K053_TARGET_PHOTO_STORAGE
  if (!['s3', 'local'].includes(storage)) throw new Error('K053_TARGET_PHOTO_STORAGE admite s3 o local')
  const objects = storage === 'local'
    ? (process.env.K053_TARGET_PHOTO_DIR ? localObjects(resolve(process.env.K053_TARGET_PHOTO_DIR)) : null)
    : storeObjects(readPhotoStorage({ PHOTO_STORAGE: 's3', PHOTO_S3_ENDPOINT: process.env.PHOTO_S3_ENDPOINT,
      PHOTO_S3_REGION: process.env.PHOTO_S3_REGION, PHOTO_S3_BUCKET: process.env.PHOTO_S3_BUCKET,
      PHOTO_S3_ACCESS_KEY_ID: process.env.PHOTO_S3_ACCESS_KEY_ID, PHOTO_S3_SECRET_ACCESS_KEY: process.env.PHOTO_S3_SECRET_ACCESS_KEY }))
  if (!objects) throw new Error('K053_TARGET_PHOTO_STORAGE=local requiere K053_TARGET_PHOTO_DIR')
  const manifest = await readManifest(resolve(directory), options['manifiesto-sha256'] ?? null)
  console.log(`Conciliación K053 contra la copia ${manifest.createdAt}${options['manifiesto-sha256'] ? ' (manifiesto verificado)' : ''}`)
  const client = target.client({ options: '-c default_transaction_read_only=on' })
  await client.connect()
  let result
  try {
    result = await reconcile({ client, manifest, objects, pickupKey: readPickupKey() })
  } finally {
    await client.end().catch(() => {})
  }
  printReconciliation(result)
  console.log(`${result.passed ? 'PASS' : 'FAIL'} K053 conciliación en ${(elapsed(started) / 1000).toFixed(1)} s`)
  process.exitCode = result.passed ? 0 : 1
} catch (error) {
  console.error(`FAIL K053 conciliación: ${String(error?.message ?? error).split('\n')[0].replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`)
  process.exitCode = 1
}
