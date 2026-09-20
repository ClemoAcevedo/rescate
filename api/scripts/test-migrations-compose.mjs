import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// Reutiliza el servicio db de K006. No crea servidor, volumen, usuario ni .env.
const root = fileURLToPath(new URL('../../', import.meta.url))
const api = fileURLToPath(new URL('../', import.meta.url))
const docker = (...args) => execFileSync('docker', ['compose', ...args], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
})
let database
try {
  // Capturado solo en memoria: nunca imprimir la salida/configuración/URL.
  const user = docker('exec', '-T', 'db', 'printenv', 'POSTGRES_USER').trim()
  const password = docker('exec', '-T', 'db', 'printenv', 'POSTGRES_PASSWORD').trim()
  const address = docker('port', 'db', '5432').trim()
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Se requiere el puerto loopback de K006')
  database = `rescate_k003_test_${Date.now()}_${randomBytes(4).toString('hex')}`
  // TEMPLATE template0 evita heredar PostGIS u objetos del entorno de desarrollo.
  docker('exec', '-T', 'db', 'createdb', '-U', user, '--template=template0', database)
  const url = new URL(`postgresql://${address}/${database}`)
  url.username = user
  url.password = password
  console.log(`Base dedicada creada en db de K006: ${database} (template0)`)
  execFileSync('npm', ['run', 'db:test'], {
    cwd: api, stdio: 'inherit', env: { ...process.env, DATABASE_URL: url.href },
  })
  console.log(`Base de prueba conservada: ${database}. No se alteró la base de desarrollo.`)
} catch {
  // No imprimir objetos de error de procesos: pueden contener entorno/credenciales.
  console.error(`FAIL K003 Compose. Revisar Docker K006 y salida de pruebas.${database ? ` Base prevista: ${database}.` : ''}`)
  process.exitCode = 1
}
