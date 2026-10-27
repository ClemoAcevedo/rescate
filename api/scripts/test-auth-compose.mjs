// K008: mismo aislamiento que K003/K010; no migra la base de desarrollo.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createTestDatabase } from './create-test-database.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const api = fileURLToPath(new URL('../', import.meta.url))
const docker = (...args) => execFileSync('docker', ['compose', ...args], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
})
let database
let databaseUrl
try {
  database = `rescate_k008_test_${Date.now()}_${randomBytes(4).toString('hex')}`
  if (process.env.DATABASE_URL) {
    databaseUrl = await createTestDatabase(process.env.DATABASE_URL, database)
  } else {
    const user = docker('exec', '-T', 'db', 'printenv', 'POSTGRES_USER').trim()
    const password = docker('exec', '-T', 'db', 'printenv', 'POSTGRES_PASSWORD').trim()
    const address = docker('port', 'db', '5432').trim()
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Se requiere el puerto loopback de K006')
    docker('exec', '-T', 'db', 'createdb', '-U', user, '--template=template0', database)
    const url = new URL(`postgresql://${address}/${database}`)
    url.username = user
    url.password = password
    databaseUrl = url.href
  }
  console.log(`Base dedicada K008 creada: ${database}`)
  execFileSync('npm', ['run', 'db:test:auth'], {
    cwd: api, stdio: 'inherit', env: { ...process.env, DATABASE_URL: databaseUrl },
  })
  console.log(`Base de prueba conservada: ${database}. No se alteró la base de desarrollo.`)
} catch {
  // Evitar errores de subprocesos que puedan contener URL/credenciales.
  console.error(`FAIL K008 funcional. Revisar salida de pruebas.${database ? ` Base prevista: ${database}.` : ''}`)
  process.exitCode = 1
}
