import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const exception = {
  advisory: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  package: 'picomatch', version: '4.0.7', expires: '2026-12-01T00:00:00.000Z',
  reason: 'Sin parche publicado; patrones del repositorio en build/lint/generación de tipos, sin entradas HTTP. Solo desarrollo.',
  upstream: 'https://github.com/micromatch/picomatch/issues/175',
}
const ancestors = {
  api: new Set(['picomatch', 'fdir', 'tinyglobby', 'json-schema-to-typescript']),
  web: new Set(['picomatch', 'fdir', 'tinyglobby', 'vite', '@vitejs/plugin-react', 'typescript-eslint',
    '@typescript-eslint/eslint-plugin', '@typescript-eslint/parser', '@typescript-eslint/typescript-estree',
    '@typescript-eslint/type-utils', '@typescript-eslint/utils']),
}

/** Conserva el informe npm íntegro; clasifica solo el aviso revisado y su propagación conocida. */
export function evaluateAudit(report, lock, now = Date.now()) {
  assert.equal(report.auditReportVersion, 2, 'Formato de auditoría desconocido')
  assert.ok(!report.error && report.vulnerabilities && report.metadata?.vulnerabilities, 'Auditoría incompleta o servicio no disponible')
  assert.equal(lock.lockfileVersion, 3, 'Lockfile no compatible')
  const allowed = ancestors[lock.packages?.['']?.name]
  assert.ok(allowed, 'Paquete sin política revisada')
  const entries = report.vulnerabilities
  assert.ok(typeof entries === 'object' && !Array.isArray(entries), 'Inventario de avisos no válido')
  for (const severity of ['high', 'critical']) {
    assert.equal(report.metadata.vulnerabilities[severity], Object.values(entries).filter(entry => entry.severity === severity).length,
      'Conteos de auditoría inconsistentes')
  }
  const devOnly = entry => entry.nodes?.length > 0 && entry.nodes.every(path => lock.packages[path]?.dev === true)
  const accepted = advisory => advisory.name === exception.package && advisory.dependency === exception.package
    && advisory.url === exception.advisory && advisory.range === '<=4.0.7' && advisory.severity === 'high'
  function exempt(name, seen = new Set()) {
    const entry = entries[name]
    if (!entry || seen.has(name) || now >= Date.parse(exception.expires)
      || entry.severity !== 'high' || !allowed.has(name) || !devOnly(entry) || !entry.via?.length) return false
    if (name === exception.package && !entry.nodes.every(path => lock.packages[path].version === exception.version)) return false
    const next = new Set(seen).add(name)
    return entry.via.every(via => typeof via === 'string' ? exempt(via, next)
      : name === exception.package && accepted(via))
  }
  const blocked = [], acceptedPackages = []
  for (const [name, entry] of Object.entries(entries)) {
    assert.ok(['info', 'low', 'moderate', 'high', 'critical'].includes(entry.severity), 'Severidad desconocida')
    if (!['high', 'critical'].includes(entry.severity)) continue
    if (exempt(name)) acceptedPackages.push(name)
    else blocked.push(name)
  }
  return { counts: report.metadata.vulnerabilities, blocked,
    accepted: acceptedPackages.length ? [{ ...exception, packages: acceptedPackages }] : [] }
}

function main() {
  // Nunca omite devDependencies: el JSON original se publica aunque la política falle.
  const result = spawnSync('npm', ['audit', '--audit-level=high', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  writeFileSync('audit.json', result.stdout || JSON.stringify({ error: result.error?.message ?? result.stderr ?? 'Auditoría sin respuesta' }))
  assert.ok(!result.error && [0, 1].includes(result.status), 'No se pudo completar npm audit')
  const report = JSON.parse(result.stdout)
  const outcome = evaluateAudit(report, JSON.parse(readFileSync('package-lock.json', 'utf8')))
  writeFileSync('audit-policy.json', JSON.stringify(outcome, null, 2) + '\n')
  console.log(JSON.stringify(outcome, null, 2))
  process.exitCode = outcome.blocked.length ? 1 : 0
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
