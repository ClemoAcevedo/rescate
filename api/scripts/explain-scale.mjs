// K032: planes reales de búsqueda, reserva, cola, compromisos, panel y worker sobre la semilla de escala.
// Intercepta pg para analizar cada sentencia que emite la API con EXPLAIN (ANALYZE, BUFFERS)
// dentro de un savepoint que se revierte; luego la sentencia corre normalmente. Así el plan
// corresponde al SQL de los repositorios y no a una copia que pueda quedar desactualizada.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createApi } from '../dist/composition.js'
import { createPool } from '../dist/infrastructure/postgres/pool.js'
import { createExpiryUseCases } from '../dist/application/expiries/use-cases.js'
import { createLotExpiryRepository } from '../dist/infrastructure/postgres/expiry-repository.js'
import { createOutboxProcessor } from '../dist/application/notifications/use-cases.js'
import { createOutboxRepository } from '../dist/infrastructure/postgres/notification-repository.js'

const statement = /^\s*(SELECT|WITH|UPDATE|INSERT|DELETE)\b/i

function instrument(plans) {
  const original = pg.Client.prototype.query
  let label = null
  pg.Client.prototype.query = function (config, values, callback) {
    const text = typeof config === 'string' ? config : config?.text
    if (typeof text === 'string' && !this.k032Explaining) {
      if (/^\s*BEGIN\b/i.test(text)) this.k032InTransaction = true
      else if (/^\s*(COMMIT|ROLLBACK)\s*$/i.test(text)) this.k032InTransaction = false
    }
    if (!label || this.k032Explaining || typeof text !== 'string' || !statement.test(text)) {
      return original.call(this, config, values, callback)
    }
    const done = typeof values === 'function' ? values : callback
    const params = Array.isArray(values) ? values : config?.values
    const [open, undo] = this.k032InTransaction ? ['SAVEPOINT k032', 'ROLLBACK TO SAVEPOINT k032'] : ['BEGIN', 'ROLLBACK']
    const step = label
    const task = (async () => {
      this.k032Explaining = true
      try {
        await original.call(this, open)
        try {
          const result = await original.call(this, `EXPLAIN (ANALYZE, BUFFERS) ${text}`, params)
          plans.push({ label: step, sql: text.replace(/\s+/g, ' ').trim(), plan: result.rows.map(row => row['QUERY PLAN']).join('\n') })
        } catch (error) {
          plans.push({ label: step, sql: text.replace(/\s+/g, ' ').trim(), plan: `Sin plan: ${error.code ?? 'error'}` })
        } finally { await original.call(this, undo) }
      } finally { this.k032Explaining = false }
      return original.call(this, typeof config === 'string' ? { text, values: params } : config)
    })()
    if (!done) return task
    task.then(result => done(null, result), error => done(error))
  }
  return { set: value => { label = value }, restore: () => { pg.Client.prototype.query = original } }
}

/** Recorridos medidos en otras tablas: un Seq Scan que lee más de 1000 filas es candidato a índice. */
export function summarize(plans) {
  return plans.map(({ label, sql, plan }) => {
    const lines = plan.split('\n')
    const scans = []
    lines.forEach((line, i) => {
      const scan = /Seq Scan on (\w+).*actual time=[\d.]+\.\.[\d.]+ rows=(\d+) loops=(\d+)/.exec(line)
      if (!scan) return
      const detail = lines.slice(i + 1, i + 4).join('\n')
      const removed = Number(/Rows Removed by Filter: (\d+)/.exec(detail)?.[1] ?? 0)
      const read = (Number(scan[2]) + removed) * Number(scan[3])
      if (read > 1000) scans.push(`${scan[1]} (${read} filas)`)
    })
    const time = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? NaN)
    return { label, sql, time, scans }
  })
}

/** Ejecuta cada operación una vez con la sesión sonda. `seed` es el resultado de seedScale. */
export async function explainScale(connectionString, seed, environment) {
  const plans = []
  const probe = instrument(plans)
  const api = createApi({ ...environment, DATABASE_URL: connectionString })
  const server = api.app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const origin = environment.RESCATE_ALLOWED_ORIGINS.split(',')[0]
  const cookies = new Map([['__Host-rescate_session', seed.probe.session]])
  let csrf = ''
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: {
      Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET' ? {} : { Origin: origin, 'X-CSRF-Token': csrf }) },
    body: body === undefined ? undefined : JSON.stringify(body) })
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';'); const at = pair.indexOf('=')
      cookies.set(pair.slice(0, at), pair.slice(at + 1))
    }
    const result = await response.json()
    if (result.csrfToken) csrf = result.csrfToken
    return { status: response.status, body: result }
  }
  const pool = createPool({ connectionString, max: 2 })
  const expiries = createExpiryUseCases(createLotExpiryRepository(pool), () => {})
  const outbox = createOutboxProcessor(createOutboxRepository(pool), () => new Date())
  const soon = new Date(Date.now() + 6 * 3600000).toISOString()
  const [lot] = seed.reserveLots
  // K035: el panel exige membership; la sonda (cuenta 61) pasa a operar el primer establecimiento.
  const { rows: [operated] } = await pool.query(`INSERT INTO memberships (user_id, establishment_id)
    SELECT u.id, e.id FROM users u, (SELECT id, public_id FROM establishments ORDER BY id LIMIT 1) e
    WHERE u.email = 'k032-0061@example.invalid' RETURNING (SELECT public_id::text FROM establishments WHERE id = establishment_id) AS id`)
  const establishment = `/establishments/${operated.id}`
  const operations = [
    ['búsqueda sin filtros', () => call('GET', '/public/lots'), 200],
    ['búsqueda por ubicación y radio', () => call('GET', '/public/lots?latitude=-33.45&longitude=-70.66&radiusKm=5'), 200],
    ['búsqueda por categoría y horario', () => call('GET', `/public/lots?category=Panader%C3%ADa&pickupBefore=${soon}`), 200],
    ['búsqueda por ubicación, página 5', () => call('GET', '/public/lots?latitude=-33.45&longitude=-70.66&page=5'), 200],
    ['detalle de lote', () => call('GET', `/public/lots/${lot}`), 200],
    ['reserva', () => call('POST', `/public/lots/${lot}/reservations`, { quantity: 1, idempotencyKey: randomUUID() }), 201],
    ['historial de reservas', () => call('GET', '/reservations'), 200],
    ['cancelación', () => call('POST', `/reservations/${seed.probe.cancels[0]}/cancel`, {}), 200],
    ['ingreso a la espera', () => call('POST', `/public/lots/${seed.queuedLots[0]}/waitlist`, { quantity: 1, idempotencyKey: randomUUID() }), 201],
    ['avisos', () => call('GET', '/notifications'), 200],
    ['panel del establecimiento', () => call('GET', `${establishment}/panel`), 200],
    ['panel con período de 60 días', () => call('GET', `${establishment}/panel?from=${new Date(Date.now() - 59 * 86400000).toISOString().slice(0, 10)}`), 200],
    ['compromisos del establecimiento', () => call('GET', `${establishment}/commitments`), 200],
    ['compromisos vigentes', () => call('GET', `${establishment}/commitments?state=active`), 200],
    ['historial del establecimiento', () => call('GET', `${establishment}/activity`), 200],
    ['historial, página 5', () => call('GET', `${establishment}/activity?page=5`), 200],
    ['vencimientos (worker)', () => expiries.expireNext(), undefined],
    ['outbox (worker)', () => outbox.processNext(), undefined],
  ]
  try {
    assert.equal((await call('GET', '/auth/session')).status, 200)
    for (const [label, run, expected] of operations) {
      probe.set(label)
      const result = await run()
      probe.set(null)
      if (expected !== undefined) assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.body)}`)
    }
    return plans
  } finally {
    probe.restore()
    await new Promise(resolve => server.close(resolve))
    await api.close()
    await pool.end()
  }
}
