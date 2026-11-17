// K053 · Restaura una copia en una base nueva rescate_k053_restore_* del servicio db de Compose,
// copia sus fotos a un directorio local, concilia y levanta la API sobre lo restaurado.
// Nunca escribe en la fuente ni en la base de desarrollo. Conserva la base salvo con --borrar.
//   K053_PICKUP_CODE_KEY   PICKUP_CODE_KEY de la fuente, para descifrar los códigos vigentes
// Uso: npm --prefix api run backup:restore -- <copia> [--anterior <commit o tag>]
//        [--manifiesto-sha256 <hex>] [--borrar]
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { composeDatabase, readPickupKey } from './support/backup.mjs'
import { printRecovery, restoreAndVerify } from './support/restore.mjs'

const interventionStarted = performance.now()
const usage = 'Uso: npm --prefix api run backup:restore -- <copia> [--anterior <commit o tag>] [--manifiesto-sha256 <hex>] [--borrar]'
const { positionals: [directory], values: options } = parseArgs({ allowPositionals: true, options: {
  anterior: { type: 'string' }, 'manifiesto-sha256': { type: 'string' }, borrar: { type: 'boolean', default: false } } })
const dropHint = database => `docker compose exec db sh -c 'dropdb -U "$POSTGRES_USER" --force ${database}'`
let created = null
try {
  if (!directory) throw new Error(usage)
  // Sin clave, la conciliación falla si hay códigos vigentes.
  const pickupKey = readPickupKey()
  console.log(`Restauración K053 de ${resolve(directory)}`)
  const report = await restoreAndVerify({ directory: resolve(directory), pickupKey, previousRelease: options.anterior ?? null, interventionStarted,
    db: composeDatabase(), manifestSha256: options['manifiesto-sha256'] ?? null, discard: options.borrar,
    onDatabase: database => { created = database } })
  printRecovery(report)
  if (options.borrar) console.log(`Base ${report.database} y fotos restauradas borradas`)
  else console.log(`Base conservada: ${report.database}. Para borrarla: ${dropHint(report.database)}`)
  console.log(`${report.passed ? 'PASS' : 'FAIL'} K053 restauración`)
  process.exitCode = report.passed ? 0 : 1
} catch (error) {
  console.error(`FAIL K053 restauración: ${String(error?.message ?? error).split('\n')[0].replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`)
  if (created && !options.borrar) console.error(`Base conservada: ${created}. Para borrarla: ${dropHint(created)}`)
  process.exitCode = 1
}
