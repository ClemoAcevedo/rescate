// K032: mezcla de E2 del anexo H (p. 19) sobre la semilla de escala: 18 búsquedas, una reserva
// y una cancelación por segundo. Solo la fase medida cuenta para p50, p95 y errores; los
// umbrales son los del anexo y no se ajustan aquí. K039 extiende este escenario para E3.
import http from 'k6/http'
import exec from 'k6/execution'
import { sleep } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const seed = JSON.parse(open(__ENV.SEED))
const base = __ENV.API_URL
const origin = __ENV.ORIGIN
const warmup = Number(__ENV.WARMUP_SECONDS ?? 30)
const measured = Number(__ENV.MEASURED_SECONDS ?? 120)
const rates = { busqueda: 18, reserva: 1, cancelacion: 1 }

const durations = Object.fromEntries(Object.keys(rates).map(op => [op, new Trend(`k032_${op}`, true)]))
const errors = new Rate('k032_errores')

function scenarios() {
  const result = {}
  for (const [op, rate] of Object.entries(rates)) {
    for (const [phase, startTime, seconds] of [['preparacion', 0, warmup], ['medida', warmup, measured]]) {
      result[`${op}_${phase}`] = { executor: 'constant-arrival-rate', exec: op, rate, timeUnit: '1s',
        startTime: `${startTime}s`, duration: `${seconds}s`, preAllocatedVUs: op === 'busqueda' ? 20 : 5,
        maxVUs: op === 'busqueda' ? 60 : 15, tags: { fase: phase }, env: { FASE: phase } }
    }
  }
  return result
}

export const options = {
  scenarios: scenarios(),
  summaryTrendStats: ['med', 'p(95)', 'max', 'count'],
  thresholds: {
    k032_busqueda: ['p(95)<=1000'],
    k032_reserva: ['p(95)<=1500'],
    'k032_errores{fase:medida}': ['rate<0.01'],
    dropped_iterations: ['count==0'],
  },
}

// Las sesiones vienen de la semilla; aquí solo se obtiene el CSRF ligado a cada una.
// Docker Desktop publica el puerto del host unos instantes después de que la API responde.
export function setup() {
  for (let attempt = 0; http.get(`${base}/health`, { tags: { name: 'setup' } }).status !== 200; attempt++) {
    if (attempt === 30) throw new Error('k6 no alcanza la API')
    sleep(0.5)
  }
  return seed.sessions.map(session => {
    const response = http.get(`${base}/auth/session`, { headers: { Cookie: `__Host-rescate_session=${session}` },
      tags: { name: 'setup' } })
    if (response.status !== 200) throw new Error(`Sesión de carga rechazada: ${response.status}`)
    const csrf = response.json('csrfToken')
    return { cookie: `__Host-rescate_session=${session}; __Host-rescate_csrf=${csrf}`, csrf }
  })
}

// La fase medida continúa la numeración de la preparación: cada índice es un par cuenta/lote único.
// El margen cubre la iteración que la preparación alcanza a iniciar en su último instante.
function index(op) {
  const offset = __ENV.FASE === 'medida' ? rates[op] * (warmup + 2) : 0
  return offset + exec.scenario.iterationInTest
}

function record(op, response, expected) {
  const ok = response.status === expected
  errors.add(!ok, { op, fase: __ENV.FASE })
  if (__ENV.FASE === 'medida') durations[op].add(response.timings.duration)
  if (!ok) console.warn(`${op}: ${response.status} ${response.body?.slice(0, 200)}`)
}

function command(account, path, body) {
  return http.post(`${base}${path}`, JSON.stringify(body), { jar: new http.CookieJar(), headers: {
    Cookie: account.cookie, Origin: origin, 'X-CSRF-Token': account.csrf, 'Content-Type': 'application/json' },
  tags: { name: path.split('/').slice(0, 3).join('/') } })
}

const searches = [
  () => '',
  () => '?latitude=-33.45&longitude=-70.66&radiusKm=5',
  () => '?latitude=-33.44&longitude=-70.65',
  () => `?category=${encodeURIComponent(['Panadería', 'Verduras', 'Frutas', 'Lácteos', 'Preparados'][Math.floor(Math.random() * 5)])}`,
  () => `?pickupBefore=${new Date(Date.now() + 6 * 3600000).toISOString()}`,
  () => `?latitude=-33.45&longitude=-70.66&page=${2 + Math.floor(Math.random() * 3)}`,
]

export function busqueda() {
  const query = searches[Math.floor(Math.random() * searches.length)]()
  record('busqueda', http.get(`${base}/public/lots${query}`, { tags: { name: '/public/lots' } }), 200)
}

export function reserva(accounts) {
  const i = index('reserva')
  const lot = seed.reserveLots[Math.floor(i / accounts.length) % seed.reserveLots.length]
  record('reserva', command(accounts[i % accounts.length], `/public/lots/${lot}/reservations`,
    { quantity: 1, idempotencyKey: crypto.randomUUID() }), 201)
}

export function cancelacion(accounts) {
  const i = index('cancelacion')
  const user = i % accounts.length
  record('cancelacion', command(accounts[user], `/reservations/${seed.cancels[user][Math.floor(i / accounts.length)]}/cancel`, {}), 200)
}

export function handleSummary(data) {
  const metric = name => data.metrics[name]?.values ?? {}
  const lines = Object.keys(rates).map(op => {
    const values = metric(`k032_${op}`)
    return `${op.padEnd(12)} p50=${values.med?.toFixed(1)} ms  p95=${values['p(95)']?.toFixed(1)} ms  max=${values.max?.toFixed(1)} ms  n=${values.count}`
  })
  lines.push(`errores      ${((metric('k032_errores{fase:medida}').rate ?? 0) * 100).toFixed(2)} %  iteraciones descartadas=${metric('dropped_iterations').count ?? 0}`)
  return { stdout: `${lines.join('\n')}\n`, '/results/k6-summary.json': JSON.stringify(data, null, 2) }
}
