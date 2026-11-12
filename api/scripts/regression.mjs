// K049 regresión de inventario y códigos. Corre cada suite con su base dedicada, una tras otra,
// y guarda commit, hash de cada script, base usada, salida y resultado en .regression-results/<id>/.
// Sigue con las demás aunque una falle, para que el resumen muestre todo lo que se rompió.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const api = fileURLToPath(new URL('../', import.meta.url))
const root = fileURLToPath(new URL('../../', import.meta.url))
// Cada suite vive en scripts/test-<name>.mjs con su wrapper scripts/test-<name>-compose.mjs.
const suites = [
  { name: 'pickup-codes', card: 'K049', covers: 'revisión previa y cada vía de cierre, código antiguo, dos operadores contra cierre en ambos órdenes' },
  { name: 'reservations', card: 'K022/K025', covers: 'última unidad, reintentos, dos operadores, cancelar contra retirar, plazos, timeout y rollback, con worker activo y detenido' },
  { name: 'waitlist', card: 'K027', covers: 'cola FIFO, ofertas parciales, aceptar contra vencer y conciliación' },
  { name: 'expiries', card: 'K028', covers: 'vencimientos con worker real, cierre repetido, reinicio y API con worker detenido' },
  { name: 'lot-management', card: 'E2', covers: 'descuentos, pausa, retiro de publicación contra entrega y última unidad contra venta local' },
  { name: 'incidents', card: 'K043', covers: 'reportes, versiones, destinatarios y lote retirado' },
  { name: 'incident-delivery', card: 'K044/K045', covers: 'cierre por incidencia, carrera cierre contra entrega y rollback' },
  { name: 'incident-followup', card: 'K047', covers: 'seguimiento después de entregar con reservas y retiros concurrentes' },
  { name: 'integrity', card: 'K039', covers: 'casos críticos a la escala del anexo H por HTTP' },
]
const only = process.argv.slice(2)
const selected = only.length ? suites.filter(suite => only.includes(suite.name)) : suites
if (!selected.length) throw new Error(`Suites disponibles ${suites.map(suite => suite.name).join(', ')}`)

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const commit = git('rev-parse', 'HEAD')
const dirty = git('status', '--porcelain').length > 0
const startedAt = new Date()
const id = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${commit.slice(0, 7)}`
const directory = new URL(`../.regression-results/${id}/`, import.meta.url)
await mkdir(directory, { recursive: true })
let postgres = null
try {
  postgres = execFileSync('docker', ['compose', 'exec', '-T', 'db', 'postgres', '--version'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
} catch { /* El fallo se verá en la primera suite. */ }

function run(suite) {
  const log = createWriteStream(new URL(`${suite.name}.log`, directory))
  const started = performance.now()
  return new Promise(resolve => {
    const child = spawn('npm', ['run', `db:test:${suite.name}:compose`], { cwd: api, env: process.env })
    let output = ''
    const forward = target => chunk => { output += chunk; log.write(chunk); target.write(chunk) }
    child.stdout.on('data', forward(process.stdout))
    child.stderr.on('data', forward(process.stderr))
    child.once('close', code => {
      log.end()
      const databases = [...new Set([...output.matchAll(/Base (?:dedicada \S+ creada|de prueba conservada): (rescate_\w+)/g)]
        .map(match => match[1]))]
      resolve({ exitCode: code, seconds: Math.round(performance.now() - started) / 1000, databases,
        groups: output.match(/^OK /gm)?.length ?? 0, races: output.match(/^RACE /gm)?.length ?? 0,
        pass: output.match(/^PASS .*$/gm) ?? [], failures: output.match(/^(FAIL|not ok).*$/gm) ?? [] })
    })
  })
}

const results = []
for (const suite of selected) {
  console.log(`\n=== K049 ${suite.name} (${suite.card})`)
  const scripts = {}
  for (const file of [`scripts/test-${suite.name}.mjs`, `scripts/test-${suite.name}-compose.mjs`]) {
    scripts[file] = await sha256(new URL(`../${file}`, import.meta.url))
  }
  const result = await run(suite)
  results.push({ ...suite, command: `npm --prefix api run db:test:${suite.name}:compose`, scripts, ...result,
    passed: result.exitCode === 0 && result.pass.length > 0, log: `${suite.name}.log` })
}

const summary = { card: 'K049', startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), commit, dirty,
  node: process.version, postgres, passed: results.every(result => result.passed), suites: results }
await writeFile(new URL('summary.json', directory), `${JSON.stringify(summary, null, 2)}\n`)
const rows = results.map(r => `| ${r.name} | ${r.card} | ${r.passed ? 'pasa' : 'falla'} | ${r.groups} | ${r.races} | ${r.seconds} s | \`${r.databases.at(-1) ?? 'sin base'}\` |`)
await writeFile(new URL('summary.md', directory), [
  `Commit \`${commit.slice(0, 7)}\`${dirty ? ' con cambios sin commit' : ''}, ${process.version}, ${postgres ?? 'PostgreSQL sin versión'}.`, '',
  '| Suite | Tarjeta | Resultado | Grupos | Carreras | Duración | Base |', '| --- | --- | --- | --- | --- | --- | --- |', ...rows, '',
].join('\n'))
console.log(`\n${summary.passed ? 'PASS' : 'FAIL'} K049 regresión: ${results.filter(r => r.passed).length}/${results.length} suites`)
console.log(`Resultados en api/.regression-results/${id}/`)
process.exitCode = summary.passed ? 0 : 1
