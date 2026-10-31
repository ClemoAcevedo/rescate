// Prepara los datos de la demo E3 por la API pública, como lo haría la web
// (docs/demo-e3.md). `previo` deja un lote que cierra con un retiro registrado;
// `en-vivo` deja el lote del guion con todos sus packs reservados por A.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { parseArgs } from 'node:util'

const { positionals: [mode], values: options } = parseArgs({ allowPositionals: true, options: {
  foto: { type: 'string' }, minutos: { type: 'string', default: '20' }, horas: { type: 'string', default: '3' },
} })
assert.ok(['previo', 'en-vivo'].includes(mode), 'Uso: npm run demo:e3 -- previo|en-vivo [--foto ruta] [--minutos N] [--horas N]')
const origin = process.env.WEB_URL
assert.ok(origin, 'Configura WEB_URL con el origen HTTPS de la web (producción o local)')
assert.equal(new URL(origin).origin, origin, 'WEB_URL debe ser un origen exacto, sin ruta')
assert.equal(new URL(origin).protocol, 'https:', 'Las cookies __Host- exigen HTTPS')
const password = process.env.DEMO_PASSWORD
assert.ok(password, 'Configura DEMO_PASSWORD; no se guarda en el repositorio')
const establishmentName = process.env.DEMO_ESTABLISHMENT ?? 'Panadería Demo Rescate'
const operatorEmail = process.env.DEMO_OPERATOR_EMAIL ?? 'operador.e3@rescate.test'
const personAEmail = process.env.DEMO_PERSON_A_EMAIL ?? 'persona.a.e3@rescate.test'
const photoTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
if (options.foto) assert.ok(photoTypes[extname(options.foto).toLowerCase()], 'La foto debe ser JPEG, PNG o WebP')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const minutes = n => n * 60_000
const clock = (iso, timeZone) => new Date(iso).toLocaleString('es-CL', { timeZone, dateStyle: 'short', timeStyle: 'short' })

/** Una sesión por cuenta: cookies del mismo origen, Origin y CSRF como el navegador. */
async function signIn(email) {
  const cookies = new Map()
  let csrf
  async function call(method, path, { json, body, type, expect } = {}) {
    const response = await fetch(`${origin}/api${path}`, { method, body: json ? JSON.stringify(json) : body, headers: {
      Origin: origin, Cookie: [...cookies].filter(([, value]) => value).map(([name, value]) => `${name}=${value}`).join('; '),
      ...(json ? { 'Content-Type': 'application/json' } : type ? { 'Content-Type': type } : {}),
      ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf }),
    } })
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';')
      cookies.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1))
    }
    const text = await response.text()
    const result = text ? JSON.parse(text) : null
    // Solo estado y código de error: las respuestas pueden traer códigos de retiro.
    if (expect !== undefined) assert.equal(response.status, expect, `${method} ${path} respondió ${response.status} ${result?.error?.code ?? ''}`)
    return result
  }
  csrf = (await call('GET', '/auth/session', { expect: 200 })).csrfToken
  const login = await call('POST', '/auth/login', { json: { email, password }, expect: 200 })
  csrf = login.csrfToken ?? (await call('GET', '/auth/session', { expect: 200 })).csrfToken
  const { session } = await call('GET', '/auth/session', { expect: 200 })
  assert.ok(session, `Sin sesión para ${email}`)
  return { call, session, signOut: () => call('POST', '/auth/logout', { expect: 204 }) }
}

let operator
let personA
try {
  operator = await signIn(operatorEmail)
  personA = await signIn(personAEmail)
  const establishment = operator.session.operableEstablishments.find(item => item.name === establishmentName)
  assert.ok(establishment, `${operatorEmail} no opera «${establishmentName}»: falta su membership`)
  const base = `/establishments/${encodeURIComponent(establishment.id)}`
  console.log(`Destino: ${origin} · ${establishment.name} · modo ${mode}`)

  // Un solo lote abierto mantiene legibles el panel y la búsqueda durante el guion.
  const panel = await operator.call('GET', `${base}/panel`, { expect: 200 })
  assert.equal(panel.current.lots.length, 0, `Ya hay ${panel.current.lots.length} lote(s) con la ventana abierta; espera su cierre o retíralos desde «Mis lotes»`)

  // El lugar se copia del último lote del establecimiento; sin lotes, la dirección conocida.
  const [latest] = (await operator.call('GET', `${base}/lots`, { expect: 200 })).items
  const place = latest
    ? await operator.call('GET', `/lots/${encodeURIComponent(latest.id)}`, { expect: 200 })
    : { address: 'Av. Vicuña Mackenna 4860, Macul', latitude: -33.4991, longitude: -70.6145, timeZone: 'America/Santiago' }

  const now = Date.now()
  const lotInput = mode === 'previo'
    ? { description: 'Pack de pan del día: marraquetas y hallullas horneadas esta mañana.', category: 'Panadería', quantity: 2,
        conditions: 'Trae tu bolsa reutilizable.', start: now - minutes(1), end: now + minutes(Number(options.minutos)) }
    : { description: 'Pack sorpresa de panadería: pan del día y una pieza dulce. Elaborado hoy; consumir dentro de 24 horas.',
        category: 'Panadería', quantity: 2, conditions: 'Trae tu bolsa reutilizable. Contiene gluten, huevo y lácteos.',
        start: now - minutes(5), end: now + minutes(60 * Number(options.horas)) }
  assert.ok(lotInput.end - now >= minutes(5), 'La ventana debe seguir abierta al menos 5 minutos')
  const { start, end, ...content } = lotInput
  let lot = await operator.call('POST', `${base}/lots`, { expect: 201, json: { ...content, address: place.address,
    latitude: place.latitude, longitude: place.longitude, timeZone: place.timeZone,
    pickupStartsAt: new Date(start).toISOString(), pickupEndsAt: new Date(end).toISOString() } })

  if (options.foto) {
    const photo = await operator.call('POST', `/lots/${encodeURIComponent(lot.id)}/photos`, { expect: 202,
      body: await readFile(options.foto), type: photoTypes[extname(options.foto).toLowerCase()] })
    let status = photo.status
    for (let attempt = 0; attempt < 60 && ['uploading', 'pending'].includes(status); attempt++) {
      await sleep(1000)
      status = (await operator.call('GET', `/lots/${encodeURIComponent(lot.id)}/photos`, { expect: 200 })).items.find(item => item.id === photo.id).status
    }
    assert.equal(status, 'ready', `La foto quedó ${status}; el borrador ${lot.id} sigue sin publicar`)
    lot = await operator.call('GET', `/lots/${encodeURIComponent(lot.id)}`, { expect: 200 })
  }
  lot = await operator.call('POST', `/lots/${encodeURIComponent(lot.id)}/publish`, { expect: 200, json: { version: lot.version } })
  const lotPath = `/lots/${encodeURIComponent(lot.id)}`

  const reservation = await personA.call('POST', `/public${lotPath}/reservations`, { expect: 201,
    json: { quantity: mode === 'previo' ? 1 : 2, idempotencyKey: randomUUID() } })
  console.log(`${personAEmail} reservó ${reservation.quantity} pack(s) de «${lot.description}»`)

  if (mode === 'previo') {
    // El código pasa de la cuenta A al operador solo en memoria, como en el mostrador.
    const { pickupCode } = await personA.call('GET', `/reservations/${encodeURIComponent(reservation.id)}`, { expect: 200 })
    const review = await operator.call('POST', `${lotPath}/pickup-reviews`, { expect: 200, json: { code: pickupCode } })
    assert.equal(review.canConfirm, true, 'La revisión no permite confirmar el retiro')
    await operator.call('POST', `${lotPath}/pickups`, { expect: 201,
      json: { reservationId: reservation.id, code: pickupCode, idempotencyKey: randomUUID() } })
    console.log(`Retiro registrado. El lote cierra el ${clock(lot.pickupEndsAt, lot.timeZone)}; desde ahí cuenta en los resultados del período.`)
  } else {
    console.log(`Lote en vivo sin packs libres hasta el ${clock(lot.pickupEndsAt, lot.timeZone)}: ${origin}/lotes/${encodeURIComponent(lot.id)}`)
  }
} catch (error) {
  // Solo el motivo: un fallo a mitad de camino puede dejar un borrador o un lote sin reservas.
  console.error(`FAIL: ${error.message.split('\n')[0]}`)
  process.exitCode = 1
} finally {
  await Promise.allSettled([operator, personA].filter(Boolean).map(account => account.signOut()))
}
