// K036: consulta diaria de operación (anexos H p. 22). Estado del worker, demora y tareas
// en error de cada cola. Solo lee; no muestra correos, códigos ni datos de chat.
import { EXPIRY_LIMITS } from '../dist/application/expiries/use-cases.js'
import { createOperations } from '../dist/infrastructure/postgres/operations.js'
import { createPool } from '../dist/infrastructure/postgres/pool.js'

if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL')
// Conexión con tope de 5 s y cada consulta con tope local: una base que deja de responder no
// deja esperando, aunque statement_timeout no llegue a actuar.
const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 1, queryTimeoutMillis: 6000, log: () => {} })
const operations = createOperations(pool, EXPIRY_LIMITS.maxAttempts)
try {
  const { database, worker } = await operations.checkHealth()
  if (database !== 'ok') {
    console.error('Base no disponible: no se pueden consultar las tareas.')
    process.exitCode = 1
  } else {
    console.log(`Worker: ${{ ok: 'activo', stopped: 'DETENIDO: sin ciclo exitoso en 60 s', unknown: 'sin latido (falta la migración K036)' }[worker]}`)
    console.table(await operations.readBacklog())
    const failed = await operations.listFailedTasks()
    if (failed.length) console.table(failed)
    else console.log('Sin tareas en error.')
  }
} catch {
  // El error puede traer host o credenciales.
  console.error('Base sin respuesta: no se pudo completar la consulta.')
  process.exitCode = 1
} finally {
  // Con la base colgada, end() esperaría la conexión que no responde.
  if (process.exitCode) process.exit()
  await pool.end()
}
