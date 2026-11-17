import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateAudit, exception } from './npm-audit.mjs'

const now = Date.parse('2026-11-17T18:00:00Z')
function fixture(packageName = 'api') {
  const advisory = { name: 'picomatch', dependency: 'picomatch', url: exception.advisory, range: '<=4.0.7', severity: 'high' }
  const report = { auditReportVersion: 2, metadata: { vulnerabilities: { high: 2, critical: 0 } }, vulnerabilities: {
    picomatch: { severity: 'high', nodes: ['node_modules/picomatch'], via: [advisory] },
    tinyglobby: { severity: 'high', nodes: ['node_modules/tinyglobby'], via: ['picomatch'] },
  } }
  const lock = { lockfileVersion: 3, packages: {
    '': { name: packageName }, 'node_modules/picomatch': { version: '4.0.7', dev: true },
    'node_modules/tinyglobby': { version: '0.2.17', dev: true },
  } }
  return { report, lock, advisory }
}

test('solo clasifica el aviso exacto y sus consumidores de desarrollo conocidos; conserva los conteos originales', () => {
  for (const name of ['api', 'web']) {
    const { report, lock } = fixture(name)
    const result = evaluateAudit(report, lock, now)
    assert.deepEqual(result.blocked, [])
    assert.deepEqual(result.accepted[0].packages, ['picomatch', 'tinyglobby'])
    assert.equal(result.counts.high, 2)
  }
})

test('producción, versión diferente, consumidor nuevo y metadatos ausentes siguen bloqueados', () => {
  for (const mutate of [
    f => { delete f.lock.packages['node_modules/picomatch'].dev },
    f => { f.lock.packages['node_modules/picomatch'].version = '4.0.6' },
    f => { delete f.lock.packages['node_modules/picomatch'] },
    f => { f.report.vulnerabilities.picomatch.nodes = [] },
    f => { f.report.vulnerabilities.picomatch.via = [] },
  ]) {
    const f = fixture(); mutate(f)
    assert.ok(evaluateAudit(f.report, f.lock, now).blocked.includes('picomatch'))
  }
  const f = fixture(); f.report.vulnerabilities.nuevo = { ...f.report.vulnerabilities.tinyglobby, nodes: ['node_modules/tinyglobby'] }; f.report.metadata.vulnerabilities.high++
  assert.ok(evaluateAudit(f.report, f.lock, now).blocked.includes('nuevo'))
  f.lock.packages['node_modules/tinyglobby'].dev = false
  assert.ok(evaluateAudit(f.report, f.lock, now).blocked.includes('tinyglobby'))
})

test('otro aviso, rango o severidad crítica en la misma dependencia no se exceptúan', () => {
  for (const mutate of [
    f => { f.advisory.url = 'https://github.com/advisories/GHSA-otro-aviso' },
    f => { f.advisory.range = '<=4.0.8' },
    f => { f.advisory.severity = 'critical'; f.report.vulnerabilities.picomatch.severity = 'critical'; f.report.metadata.vulnerabilities.high--; f.report.metadata.vulnerabilities.critical++ },
    f => { f.report.vulnerabilities.picomatch.via.push({ ...f.advisory, url: 'https://github.com/advisories/GHSA-otro-aviso' }) },
  ]) {
    const f = fixture(); mutate(f)
    assert.ok(evaluateAudit(f.report, f.lock, now).blocked.includes('picomatch'))
  }
})

test('la excepción vence sin gracia y no acepta ciclos ni referencias desconocidas', () => {
  const { report, lock } = fixture()
  assert.equal(evaluateAudit(report, lock, Date.parse(exception.expires) - 1).blocked.length, 0)
  assert.equal(evaluateAudit(report, lock, Date.parse(exception.expires)).blocked.length, 2)
  report.vulnerabilities.picomatch.via = ['tinyglobby']
  assert.equal(evaluateAudit(report, lock, now).blocked.length, 2)
  report.vulnerabilities.picomatch.via = ['desconocido']
  assert.equal(evaluateAudit(report, lock, now).blocked.length, 2)
})

test('errores de servicio, informes incompletos, otro lockfile o paquete fallan cerrados', () => {
  for (const mutate of [
    f => { f.report.error = { message: 'registry no disponible' } },
    f => { delete f.report.metadata },
    f => { delete f.report.vulnerabilities },
    f => { f.report.vulnerabilities = {} },
    f => { f.report.auditReportVersion = 3 },
    f => { f.lock.lockfileVersion = 2 },
    f => { f.lock.packages[''].name = 'otro' },
    f => { f.report.vulnerabilities.picomatch.severity = 'desconocida' },
  ]) {
    const f = fixture(); mutate(f)
    assert.throws(() => evaluateAudit(f.report, f.lock, now))
  }
})
