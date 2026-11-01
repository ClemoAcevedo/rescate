import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Los ejecutores operativos son módulos JavaScript.
import { assertLoadEnvironment, assertLoadUrl, assertDatabaseProxy, trialDatabaseUrls } from '../scripts/support/railway-load.mjs'
// @ts-expect-error Los ejecutores operativos son módulos JavaScript.
import { evaluate, OPS } from '../scripts/support/scale-results.mjs'

const ids = { api: 'api', worker: 'worker', db: 'db' }
const environment = (id: string, name: string, volume: string) => ({ id, name, projectId: 'project',
  serviceInstances: { edges: Object.values(ids).map(serviceId => ({ node: { serviceId } })) },
  volumeInstances: { edges: [{ node: { serviceId: 'db', externalId: volume } }] } })
const production = environment('prod', 'production', 'production-volume')

test('La carga exige un entorno y volumen distintos de producción', () => {
  const stage = environment('stage', 'carga-e3', 'stage-volume')
  assert.doesNotThrow(() => assertLoadEnvironment(stage, production, ids))
  assert.throws(() => assertLoadEnvironment(production, production, ids))
  assert.throws(() => assertLoadEnvironment({ ...stage, name: 'development' }, production, ids))
  assert.throws(() => assertLoadEnvironment(environment('stage', 'carga-e3', 'production-volume'), production, ids))
  assert.throws(() => assertLoadEnvironment({ ...stage, projectId: 'other' }, production, ids))
  assert.throws(() => assertLoadEnvironment(stage, { ...production, name: 'carga-e3' }, ids))
  assert.throws(() => assertLoadEnvironment(stage, production, { ...ids, worker: 'api' }))
})

test('El destino HTTPS y el proxy SQL deben pertenecer al entorno de carga', () => {
  assert.equal(assertLoadUrl('https://stage.example', ['prod.example'], ['stage.example']), 'https://stage.example')
  for (const url of ['https://prod.example', 'http://stage.example', 'https://stage.example/api', 'https://stage.example:3000', 'https://a:b@stage.example', 'https://other.example']) {
    assert.throws(() => assertLoadUrl(url, ['prod.example'], ['stage.example']))
  }
  const proxies = [{ domain: 'proxy.example', proxyPort: 1234 }]
  assert.doesNotThrow(() => assertDatabaseProxy('postgresql://user:secret@proxy.example:1234/postgres', proxies))
  assert.doesNotThrow(() => assertDatabaseProxy('postgresql://user:secret@proxy.example.:1234/postgres', proxies))
  assert.throws(() => assertDatabaseProxy('postgresql://user:secret@other.example:1234/postgres', proxies))
  assert.throws(() => assertDatabaseProxy('postgresql://user:secret@proxy.example:5555/postgres', proxies))
  const urls = trialDatabaseUrls('postgresql://u:p@public:1234/postgres', 'postgresql://u:p@private:5432/postgres', 'rescate_k032_railway_test')
  assert.ok(urls.every((url: string) => new URL(url).pathname === '/rescate_k032_railway_test'))
  assert.throws(() => trialDatabaseUrls(urls[0], urls[1], 'rescate'))
})

function trial() {
  const metrics: Record<string, { values: Record<string, number> }> = { iterations: { values: { count: 100 } } }
  for (const op of OPS.e3) {
    metrics[`k032_${op}_con_inesperados{fase:medida}`] = { values: { count: 100, 'p(95)': 200 } }
    metrics[`k032_errores{op:${op},fase:medida}`] = { values: { passes: 0, fails: 100 } }
  }
  return { summary: { metrics }, invariants: [{ ok: true }] }
}

test('Las metas compartidas rechazan muestras ausentes, errores al 1 %, descartes e inconsistencias', () => {
  const good = trial()
  assert.ok(evaluate(good).every((goal: { ok: boolean }) => goal.ok))
  for (const [metric, values] of [
    ['k032_busqueda_con_inesperados{fase:medida}', { count: 0, 'p(95)': 0 }],
    ['k032_reserva_con_inesperados{fase:medida}', { count: 100, 'p(95)': 1501 }],
    ['k032_errores{op:mensaje,fase:medida}', { passes: 1, fails: 99 }],
    ['dropped_iterations', { count: 1 }],
    ['k032_esperados{op:chat,fase:medida}', { count: 1 }],
  ] as [string, Record<string, number>][]) {
    const bad = trial()
    bad.summary.metrics[metric] = { values }
    assert.ok(evaluate(bad).some((goal: { ok: boolean }) => !goal.ok), metric)
  }
  assert.ok(evaluate({ ...good, invariants: [{ ok: false }] }).some((goal: { ok: boolean }) => !goal.ok))
  assert.ok(evaluate({ summary: null, invariants: [] }).some((goal: { ok: boolean }) => !goal.ok))
})
