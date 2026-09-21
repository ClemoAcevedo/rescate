// Medición local reproducible; no prueba de carga HTTP ni datos reales.
// Cada perfil corre en un proceso distinto para separar el máximo RSS.
import { execFileSync } from 'node:child_process'
import { randomBytes, scrypt } from 'node:crypto'
import { cpus, release, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

const profiles = [
  { N: 131072, r: 8, p: 1 },
  { N: 65536, r: 8, p: 2 },
]
const maxmem = 192 * 1024 * 1024
const round = value => Math.round(value * 10) / 10
const summary = samples => {
  const sorted = [...samples].sort((a, b) => a - b)
  return { samples: samples.length, minMs: round(sorted[0]), medianMs: round((sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2), maxMs: round(sorted.at(-1)) }
}

if (process.argv[2] === '--profile') {
  const profile = profiles[Number(process.argv[3])]
  if (!profile) throw new Error('Perfil de benchmark desconocido')
  const baselineRssMiB = process.memoryUsage().rss / 1024 ** 2
  const salt = randomBytes(16)
  const derive = () => new Promise((resolve, reject) => {
    const start = performance.now()
    scrypt('Solo benchmark local — contraseña ficticia', salt, 64, { ...profile, maxmem }, error => {
      if (error) reject(error)
      else resolve(performance.now() - start)
    })
  })
  await derive() // Calentamiento, excluido de las latencias.
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  const sequential = []
  for (let i = 0; i < 10; i++) sequential.push(await derive())
  const concurrent = []
  for (let i = 0; i < 3; i++) concurrent.push(...await Promise.all([derive(), derive()]))
  loop.disable()
  console.log(JSON.stringify({
    profile, maxmemMiB: maxmem / 1024 ** 2,
    sequential: summary(sequential), concurrentTwo: summary(concurrent),
    baselineRssMiB: round(baselineRssMiB), peakRssMiB: round(process.resourceUsage().maxRSS / 1024),
    eventLoopP99Ms: round(loop.percentile(99) / 1e6),
  }))
} else {
  console.log(JSON.stringify({
    node: process.version, openssl: process.versions.openssl, platform: process.platform,
    arch: process.arch, kernel: release(), cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, hostMemoryMiB: round(totalmem() / 1024 ** 2),
    note: 'RSS incluye runtime; memoria del host no es presupuesto del despliegue. Sin SQL/HTTP.',
  }))
  for (let index = 0; index < profiles.length; index++) {
    const result = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--profile', String(index)],
      { encoding: 'utf8', timeout: 60000 })
    process.stdout.write(result)
  }
}
