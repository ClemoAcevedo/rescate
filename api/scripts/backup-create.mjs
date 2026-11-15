// K053 · Copia de PostgreSQL y fotos con manifiesto (docs/operacion.md#copia-y-restauración-rnf08).
// Solo lee la fuente: volcado y conteos en una transacción de solo lectura y GetObject en el
// bucket. La fuente llega por variables, nunca por argumentos; docs/operacion.md explica cómo
// cargarlas sin que queden en el historial de la terminal:
//   K053_SOURCE_DATABASE_URL         base de origen; fuera de este equipo, con sslmode=require o verify-*
//   K053_SOURCE_PHOTO_STORAGE        s3 (con las PHOTO_S3_* de la API) o local
//   K053_SOURCE_PHOTO_DIR            con local: el PHOTO_LOCAL_DIR de la API
//   K053_ALLOW_PLAINTEXT=1           acepta una fuente remota sin TLS
// Uso: npm --prefix api run backup:create [-- --salida <directorio nuevo o vacío>]
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { readPhotoStorage } from '../dist/composition.js'
import { createBackup, remoteDatabase, repositoryState, resultsDirectory, sha256File } from './support/backup.mjs'

const { values: options } = parseArgs({ options: { salida: { type: 'string' } } })
const storage = process.env.K053_SOURCE_PHOTO_STORAGE
try {
  if (!process.env.K053_SOURCE_DATABASE_URL) throw new Error('Falta K053_SOURCE_DATABASE_URL')
  const source = await remoteDatabase(process.env.K053_SOURCE_DATABASE_URL, 'K053_SOURCE_DATABASE_URL')
  if (!['s3', 'local'].includes(storage)) throw new Error('K053_SOURCE_PHOTO_STORAGE admite s3 o local')
  // Las mismas reglas que la API: endpoint HTTPS, directorio obligatorio con local.
  const objects = readPhotoStorage({ PHOTO_STORAGE: storage, PHOTO_LOCAL_DIR: process.env.K053_SOURCE_PHOTO_DIR,
    PHOTO_S3_ENDPOINT: process.env.PHOTO_S3_ENDPOINT, PHOTO_S3_REGION: process.env.PHOTO_S3_REGION,
    PHOTO_S3_BUCKET: process.env.PHOTO_S3_BUCKET, PHOTO_S3_ACCESS_KEY_ID: process.env.PHOTO_S3_ACCESS_KEY_ID,
    PHOTO_S3_SECRET_ACCESS_KEY: process.env.PHOTO_S3_SECRET_ACCESS_KEY })
  const { commit } = repositoryState()
  const directory = resolve(options.salida ?? join(resultsDirectory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${commit.slice(0, 7)}`))
  console.log(`Copia K053 en ${directory}`)
  const manifest = await createBackup({ source, objects, storage, directory })
  console.log(`Instantánea ${manifest.createdAt}: PostgreSQL ${manifest.source.serverVersion}, PostGIS ${manifest.source.postgis}, `
    + `${manifest.source.migrations.length} migraciones (última ${manifest.source.lastMigration})`)
  console.log(`Volcado ${manifest.database.bytes} bytes sha256 ${manifest.database.sha256}`)
  console.log(`Fotos listas ${manifest.photos.readyPhotos}: ${manifest.photos.objects.length} objetos copiados, ${manifest.photos.missing.length} faltantes en la fuente`)
  for (const item of manifest.photos.missing) console.log(`  FALTA ${item.key}`)
  console.log(`manifest.json sha256 ${(await sha256File(join(directory, 'manifest.json'))).sha256} (registrarlo con la copia)`)
  console.log(`${manifest.photos.missing.length ? 'WARN' : 'PASS'} K053 copia en ${(manifest.durations.totalMs / 1000).toFixed(1)} s`)
} catch (error) {
  // Solo el motivo: el error de pg o del SDK puede traer host o credenciales.
  console.error(`FAIL K053 copia: ${String(error?.message ?? error).split('\n')[0].replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`)
  process.exitCode = 1
}
