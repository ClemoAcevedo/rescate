// K032/K039: mezclas del anexo H (p. 19) sobre la semilla de escala. MIX=e2 (por omisión): 18
// búsquedas, una reserva y una cancelación por segundo. MIX=e3: 10 búsquedas, 4 lecturas de
// chat, 3 de bandeja, una reserva, una cancelación y un envío de mensaje por segundo. Solo la
// fase medida cuenta para los umbrales, que son los del anexo y no se ajustan aquí.
import http from 'k6/http'
import exec from 'k6/execution'
import { sleep } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'

const seed = JSON.parse(open(__ENV.SEED))
const base = __ENV.API_URL
const origin = __ENV.ORIGIN
const warmup = Number(__ENV.WARMUP_SECONDS ?? 30)
const measured = Number(__ENV.MEASURED_SECONDS ?? 120)
const mixes = {
  e2: { busqueda: 18, reserva: 1, cancelacion: 1 },
  e3: { busqueda: 10, chat: 4, bandeja: 3, reserva: 1, cancelacion: 1, mensaje: 1 },
}
const mix = __ENV.MIX ?? 'e2'
const rates = mixes[mix]
if (!rates) throw new Error(`MIX admite ${Object.keys(mixes).join(' o ')}`)
const ops = Object.keys(rates)
const phases = ['preparacion', 'medida']
// El navegador espera hasta 10 s (anexo H p. 20); un timeout es un error inesperado.
const timeout = '10s'
const timeoutMs = 10000
// Cupo de envíos por usuario del anexo H p. 21.
const messagesPerMinute = 12

// k032_<op> mide solo respuestas exitosas. El P95 de las metas usa k032_<op>_con_inesperados,
// que suma los errores inesperados: el anexo lo define sobre las solicitudes medidas y un error
// lento no debe quedar fuera. Los rechazos esperados no entran en ninguno de los dos.
const durations = Object.fromEntries(ops.map(op => [op, new Trend(`k032_${op}`, true)]))
const measuredDurations = Object.fromEntries(ops.map(op => [op, new Trend(`k032_${op}_con_inesperados`, true)]))
const errors = new Rate('k032_errores')
const expected = new Counter('k032_esperados')
// Escrituras sin resultado conocido (sin respuesta, 5xx o 2xx inválido): pudieron confirmarse en la base.
const uncertain = new Counter('k032_inciertas')
const connections = new Counter('k032_conexiones_nuevas')

// Cuatro VU por solicitud por segundo. k6 descarta la iteración que no encuentra un VU libre:
// con dos, una pausa de unos 3 s del equipo ya descartaba iteraciones de las operaciones de 1/s.
// k6 los rota y cada uno vuelve a usarse en unos 4 s, antes de que la API cierre la conexión
// ociosa (keepAliveTimeout de Node, 5 s).
function scenarios() {
  const result = {}
  for (const [op, rate] of Object.entries(rates)) {
    for (const [phase, startTime, seconds] of [['preparacion', 0, warmup], ['medida', warmup, measured]]) {
      result[`${op}_${phase}`] = { executor: 'constant-arrival-rate', exec: op, rate, timeUnit: '1s',
        startTime: `${startTime}s`, duration: `${seconds}s`, preAllocatedVUs: rate * 4,
        maxVUs: rate * 8, tags: { fase: phase }, env: { FASE: phase } }
    }
  }
  return result
}

// Un umbral vacío solo publica la submétrica en el resumen; los reales van después y prevalecen.
const reported = names => Object.fromEntries(names.map(name => [name, []]))
export const options = {
  scenarios: scenarios(),
  summaryTrendStats: ['med', 'p(95)', 'max', 'count'],
  thresholds: {
    ...reported(ops.flatMap(op => phases.flatMap(phase => [`k032_${op}{fase:${phase}}`, `k032_${op}_con_inesperados{fase:${phase}}`,
      `dropped_iterations{scenario:${op}_${phase}}`]))),
    ...reported(ops.flatMap(op => [`k032_errores{op:${op},fase:preparacion}`, `k032_esperados{op:${op},fase:preparacion}`,
      `k032_inciertas{op:${op}}`])),
    ...reported(phases.flatMap(phase => [`http_req_blocked{fase:${phase}}`, `http_req_connecting{fase:${phase}}`,
      `k032_conexiones_nuevas{fase:${phase}}`])),
    'k032_busqueda_con_inesperados{fase:medida}': ['p(95)<=1000'],
    'k032_reserva_con_inesperados{fase:medida}': ['p(95)<=1500'],
    ...Object.fromEntries(ops.map(op => [`k032_errores{op:${op},fase:medida}`, ['rate<0.01']])),
    // Los datos están preparados para que todo sea válido: un rechazo esperado invalida el ensayo.
    ...Object.fromEntries(ops.map(op => [`k032_esperados{op:${op},fase:medida}`, ['count==0']])),
    dropped_iterations: ['count==0'],
  },
}

// Índices que consume cada operación, incluida la iteración extra que k6 puede iniciar al cerrar la fase medida.
const needed = op => (rates[op] ?? 0) * (warmup + 2 + measured) + 1

// Las sesiones vienen de la semilla; aquí solo se obtiene el CSRF ligado a cada una.
export function setup() {
  const shortage = []
  if (needed('reserva') > seed.reserveLots.length * seed.sessions.length) shortage.push('lotes para reservar')
  if (needed('cancelacion') > Math.min(...seed.cancels.map(list => list.length)) * seed.sessions.length) shortage.push('reservas para cancelar')
  if (rates.chat || rates.mensaje) {
    if (!(seed.chats?.length > 0)) shortage.push('conversaciones de chat')
    else if (Date.parse(seed.chatsOpenUntil) < Date.now() + (warmup + measured + 60) * 1000) shortage.push('ventana de los chats')
    else if (rates.mensaje * 60 / seed.chats.length > messagesPerMinute) shortage.push('cuentas para enviar bajo el cupo de mensajes')
  }
  if (shortage.length) throw new Error(`La semilla no alcanza para ${warmup} + ${measured} s de ${mix}: ${shortage.join(', ')}`)
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

function json(response) {
  try { return response.json() } catch { return null }
}

// Cuerpo mínimo válido de cada operación: un 2xx con otro contenido es un resultado
// funcionalmente incorrecto (anexo H p. 19) y cuenta como error inesperado. La semilla
// garantiza datos: toda búsqueda tiene lotes, after=0 trae la primera página completa de
// una conversación de 60 o más mensajes y cada cuenta de carga tiene avisos.
const valid = {
  busqueda: body => Array.isArray(body?.items) && body.items.length >= 1 && body.items.length <= 12,
  reserva: body => typeof body?.id === 'string' && body.quantity === 1,
  cancelacion: body => body?.status === 'cancelled',
  chat: body => Array.isArray(body?.items) && body.items.length === 50 && body.items.every((item, i) => item?.sequence === i + 1)
    && body.hasMore === true && body.open === true,
  bandeja: body => Array.isArray(body?.items) && body.items.length >= 1 && body.items.length <= 20
    && Number.isInteger(body.unreadCount),
  mensaje: body => Number.isInteger(body?.sequence) && body.sequence > 0,
}
// Rechazos que el contrato documenta para cada operación (api/src/http/errors.ts). El código
// CONFLICT también cubre otros motivos (lote en revisión, reserva activa, clave reutilizada),
// que aquí son inesperados: se distinguen por el mensaje. Si un mensaje cambia, la respuesta
// cuenta como inesperada y el ensayo falla, nunca al revés.
const limited = 'Intenta nuevamente después del tiempo indicado.'
const rejections = {
  reserva: ['El lote cerró o no tiene packs suficientes.'],
  cancelacion: ['La reserva fue cancelada.', 'La reserva venció: la ventana de retiro cerró.', 'La reserva ya fue retirada.'],
  mensaje: ['La conversación está cerrada porque la reserva terminó.'],
}
const writes = new Set(Object.keys(rejections))

function record(op, response, status) {
  const phase = __ENV.FASE
  const body = json(response)
  const { code = '', message = '' } = body?.error ?? {}
  const result = response.status === status && valid[op](body) ? 'exito'
    : (response.status === 409 && code === 'CONFLICT' && rejections[op]?.includes(message))
      || (response.status === 429 && code === 'RATE_LIMITED' && message === limited) ? 'esperado' : 'inesperado'
  errors.add(result === 'inesperado', { op, fase: phase })
  if (result === 'exito') durations[op].add(response.timings.duration, { fase: phase })
  // Una solicitud sin respuesta cuenta con lo máximo que espera el navegador.
  if (result !== 'esperado') measuredDurations[op].add(response.status === 0 ? Math.max(timeoutMs, response.timings.duration)
    : response.timings.duration, { fase: phase })
  if (result === 'esperado') expected.add(1, { op, fase: phase, status: String(response.status), code })
  if (result === 'inesperado' && writes.has(op) && (response.status === 0 || response.status >= 500
    || (response.status >= 200 && response.status < 300))) {
    uncertain.add(1, { op, fase: phase })
  }
  if (response.timings.connecting > 0) connections.add(1, { fase: phase })
  if (result !== 'exito') console.warn(`${op} ${phase} ${result}: ${response.status} ${response.error ?? ''} ${response.body?.slice(0, 200) ?? ''}`)
}

const read = (account, path, name) => http.get(`${base}${path}`, { timeout,
  headers: account ? { Cookie: account.cookie } : {}, tags: { name } })

function command(account, path, body, name) {
  return http.post(`${base}${path}`, JSON.stringify(body), { timeout, jar: new http.CookieJar(), headers: {
    Cookie: account.cookie, Origin: origin, 'X-CSRF-Token': account.csrf, 'Content-Type': 'application/json' },
  tags: { name } })
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
  record('busqueda', read(null, `/public/lots${query}`, '/public/lots'), 200)
}

export function reserva(accounts) {
  const i = index('reserva')
  const lot = seed.reserveLots[Math.floor(i / accounts.length)]
  record('reserva', command(accounts[i % accounts.length], `/public/lots/${lot}/reservations`,
    { quantity: 1, idempotencyKey: crypto.randomUUID() }, '/public/lots/{lotId}/reservations'), 201)
}

export function cancelacion(accounts) {
  const i = index('cancelacion')
  const user = i % accounts.length
  record('cancelacion', command(accounts[user], `/reservations/${seed.cancels[user][Math.floor(i / accounts.length)]}/cancel`, {},
    '/reservations/{reservationId}/cancel'), 200)
}

// Lectura conservadora: after=0 trae la página completa de 50 mensajes, no solo los nuevos
// que traería la consulta periódica con la última secuencia vista.
export function chat(accounts) {
  const user = index('chat') % seed.chats.length
  record('chat', read(accounts[user], `/reservations/${seed.chats[user]}/messages?after=0`, '/reservations/{reservationId}/messages'), 200)
}

export function bandeja(accounts) {
  record('bandeja', read(accounts[index('bandeja') % accounts.length], '/notifications?page=1', '/notifications'), 200)
}

// Cada cuenta con chat envía uno cada 20 s, bajo el cupo de 12 por minuto con ráfaga de 3.
export function mensaje(accounts) {
  const user = index('mensaje') % seed.chats.length
  const text = 'Mensaje de carga K039 para coordinar el retiro. '.repeat(21).slice(0, 1 + Math.floor(Math.random() * 1000)).trim()
  record('mensaje', command(accounts[user], `/reservations/${seed.chats[user]}/messages`,
    { text, idempotencyKey: crypto.randomUUID() }, '/reservations/{reservationId}/messages'), 201)
}

const ms = value => (value === undefined ? '-' : value.toFixed(1)).padStart(8)
const count = value => String(value ?? 0).padStart(6)

export function handleSummary(data) {
  const metric = name => data.metrics[name]?.values ?? {}
  // Sin muestras k6 informa ceros; aquí se muestran como ausentes.
  const trend = name => metric(name).count ? metric(name) : {}
  const lines = [`Mezcla ${mix}: ${ops.map(op => `${op} ${rates[op]}/s`).join(', ')}; ${warmup} s de preparación y ${measured} s medidos`]
  for (const phase of phases) {
    lines.push('', `Fase ${phase}       p50 ms   p95 ms   max ms  éxitos  p95 c/inesp.   total inesp. esper.`)
    for (const op of ops) {
      const latency = trend(`k032_${op}{fase:${phase}}`)
      const all = trend(`k032_${op}_con_inesperados{fase:${phase}}`)
      const rate = metric(`k032_errores{op:${op},fase:${phase}}`)
      lines.push(`  ${op.padEnd(12)} ${ms(latency.med)} ${ms(latency['p(95)'])} ${ms(latency.max)} ${count(latency.count)}     ${ms(all['p(95)'])}`
        + `  ${count((rate.passes ?? 0) + (rate.fails ?? 0))} ${count(rate.passes)} ${count(metric(`k032_esperados{op:${op},fase:${phase}}`).count)}`)
    }
  }
  lines.push('', 'Conexión (fuera de la duración HTTP)  p50 ms   p95 ms   max ms  nuevas')
  for (const phase of phases) {
    const blocked = trend(`http_req_blocked{fase:${phase}}`)
    const connecting = trend(`http_req_connecting{fase:${phase}}`)
    lines.push(`  bloqueo/DNS ${phase.padEnd(12)}           ${ms(blocked.med)} ${ms(blocked['p(95)'])} ${ms(blocked.max)}`)
    lines.push(`  conexión ${phase.padEnd(12)}              ${ms(connecting.med)} ${ms(connecting['p(95)'])} ${ms(connecting.max)} ${count(metric(`k032_conexiones_nuevas{fase:${phase}}`).count)}`)
  }
  const dropped = ops.flatMap(op => phases.map(phase => [`${op}_${phase}`, metric(`dropped_iterations{scenario:${op}_${phase}}`).count ?? 0]))
    .filter(([, value]) => value > 0)
  lines.push('', `Iteraciones descartadas: ${metric('dropped_iterations').count ?? 0}${dropped.length ? ` (${dropped.map(([name, value]) => `${name} ${value}`).join(', ')})` : ''}`)
  lines.push(`Escrituras inciertas (sin respuesta, 5xx o 2xx inválido): ${[...writes].filter(op => rates[op])
    .map(op => `${op} ${metric(`k032_inciertas{op:${op}}`).count ?? 0}`).join(', ')}`)
  const failed = Object.entries(data.metrics).flatMap(([name, value]) => Object.entries(value.thresholds ?? {})
    .filter(([, threshold]) => !threshold.ok).map(([rule]) => `${name} ${rule}`))
  lines.push(!data.metrics.iterations ? 'Sin iteraciones: la carga no se ejecutó.'
    : failed.length ? `Umbrales no cumplidos: ${failed.join('; ')}` : 'Umbrales cumplidos.')
  // setup_data trae las cookies de sesión y los CSRF de setup(): no se guardan con las métricas.
  return { stdout: `${lines.join('\n')}\n`, '/results/k6-summary.json': JSON.stringify({ ...data, setup_data: undefined }, null, 2) }
}
