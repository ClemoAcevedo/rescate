import assert from 'node:assert/strict'
import { chromium } from './support/browser.mjs'

// Ejecuta los clientes reales de Vite en Chromium, con respuestas HTTP controladas.
const base = (process.env.WEB_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const browser = await chromium.launch()
const page = await browser.newPage({ ignoreHTTPSErrors: true })
const csrfToken = 'controlled'
const at = '2030-01-15T18:00:00Z'
const account = { user: { id: 'u1', email: 'ana@example.invalid' }, expiresAt: at, operableEstablishments: [] }
const validIncident = { id: 'i1', status: 'reported', version: 0, reportReason: 'No coincide.', reportedAt: at, versions: [] }
const inventory = { free: 2, reserved: 0, offered: 0, delivered: 0, unassignable: 0 }
const panel = {
  establishment: { id: 'e1', name: 'Local ficticio', timeZone: 'America/Santiago' }, asOf: at,
  current: { lots: [], inventory, confirmedReservations: 0, activeOffers: 0, waitingRequests: 0 },
  period: { from: '2030-01-01', to: '2030-01-15', closedLots: 0,
    packs: { published: 0, delivered: 0, unassignable: 0 }, reservations: { confirmed: 0, cancelled: 0, expired: 0, delivered: 0 },
    deliveryRate: { numerator: 0, denominator: 0, value: 1 }, reservationExpiryRate: { numerator: 0, denominator: 0, value: null },
    excluded: { openLots: 0, draftLots: 0 } },
}
const rejects = [
  ['session', '/api/auth/session', { json: { session: null } }, /sesión no tiene el formato/],
  ['session', '/api/auth/session', { json: { csrfToken, session: { ...account, expiresAt: false } } }, /no contiene una sesión válida/],
  ['session', '/api/auth/session', { json: { csrfToken, session: { ...account, user: {} } } }, /no contiene un usuario válido/],
  ['session', '/api/auth/session', { json: { csrfToken, session: { ...account, operableEstablishments: [{}] } } }, /establecimiento inválido/],
  ['session', '/api/auth/session', { contentType: 'application/json', body: '{' }, /sesión no tiene el formato/],
  ['session', '/api/auth/session', { contentType: 'text/html', body: '<html>Proxy temporal</html>' }, /contenido no JSON/],
  ['login', '/api/auth/login', { json: { session: null, csrfToken } }, /acceso no devolvió una sesión válida/],
  ['register', '/api/auth/register', { json: [] }, /registro no tiene el formato/],
  ['lot', '/api/lots/l1', { json: { status: 'draft', conditions: null, publishedAt: at } }, /estado de publicación/],
  ['lot', '/api/lots/l1', { json: { status: 'draft', conditions: false, publishedAt: null } }, /condiciones válidas/],
  ['lot', '/api/lots/l1', { json: { status: 'draft', conditions: null, publishedAt: null } }, /id válido/],
  ['photos', '/api/lots/l1/photos', { json: { items: [{ id: 'p1', position: 1, status: 'unknown' }], limit: 3 } }, /foto con formato inesperado/],
  ['management', '/api/lots/l1/management', { json: { lotId: 'l1', status: 'published', version: 1,
    paused: false, freeQuantity: -1, offeredQuantity: 0, reservedQuantity: 0, deliveredQuantity: 0, unassignableQuantity: 0, history: [] } }, /inventario no tiene el formato/],
  ['incidents', '/api/lots/l1/incidents', { json: { items: [{ ...validIncident, version: 1 }] } }, /Versiones incompletas/],
  ['incidents', '/api/lots/l1/incidents', { status: 204 }, /Respuesta vacía/],
  ['incidents', '/api/lots/l1/incidents', { json: { items: [null] } }, /Incidencia inesperada/],
  ['establishmentIncidents', '/api/establishments/e1/incidents', { json: { items: [], page: 1, hasNextPage: false } }, /Página inesperada/],
  ['panel', '/api/establishments/e1/panel', { json: panel }, /Indicador incoherente/],
  ['notifications', '/api/notifications', { json: { items: [], page: 1, hasNextPage: false, unreadCount: -1 } }, /Bandeja inesperada/],
  ['establishment', '/api/establishments/e1', { json: { id: 'e1', name: 'Local ficticio' } }, /datos de retiro válidos/],
]

const reservation = { quantity: 2, idempotencyKey: 'bd659773-b50c-4f2b-b9fb-09c05bc86426' }
const command = { reason: 'No coincide.', idempotencyKey: reservation.idempotencyKey }

try {
  await page.route('**/__service-contracts', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><title>Contratos HTTP de la web</title>' }))
  await page.goto(base + '/__service-contracts')
  const outcomes = await page.evaluate(async ({ csrfToken, reservation, command }) => {
    const { createIdentityService } = await import('/src/services/identity-service.ts')
    const { listLotPhotos, getLot, getLotManagement } = await import('/src/services/lots-service.ts')
    const { listLotIncidents, listEstablishmentIncidents, reportIncident, incidentError, isUncertain } = await import('/src/services/incidents-service.ts')
    const { reserveLot, uncertainReservation } = await import('/src/services/discovery-service.ts')
    const { getPanel } = await import('/src/services/panel-service.ts')
    const { listNotifications } = await import('/src/services/notifications-service.ts')
    const { getEstablishment } = await import('/src/services/establishments-service.ts')
    const identity = createIdentityService()
    const credentials = { email: 'ana@example.invalid', password: 'Clave ficticia' }
    window.callService = async (name) => {
      const calls = { session: () => identity.getSession(), login: () => identity.login(credentials, csrfToken),
        register: () => identity.register({ ...credentials, privacyConsent: true }, csrfToken),
        lot: () => getLot('l1'), photos: () => listLotPhotos('l1'), management: () => getLotManagement('l1'),
        incidents: () => listLotIncidents('l1'), establishmentIncidents: () => listEstablishmentIncidents('e1', { status: 'open', page: 2 }),
        panel: () => getPanel('e1', {}), notifications: () => listNotifications(1), establishment: () => getEstablishment('e1'),
        reserve: () => reserveLot('l1', reservation, csrfToken), report: () => reportIncident('l1', command, csrfToken) }
      try {
        await calls[name]()
        return { name: 'fulfilled' }
      } catch (error) {
        return { name: error.name, message: error.message, status: error.status,
          ...(name === 'report' && { incidentMessage: incidentError(error), uncertain: isUncertain(error) }),
          ...(name === 'reserve' && { uncertain: uncertainReservation(error) }) }
      }
    }
    return typeof window.callService
  }, { csrfToken, reservation, command })
  assert.equal(outcomes, 'function')

  let next
  const requests = []
  await page.route('**/api/**', route => {
    const request = route.request()
    requests.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postData() })
    assert.ok(next.length > 0, `Solicitud inesperada: ${request.url()}`)
    return route.fulfill(next.shift())
  })
  const call = (name) => page.evaluate(name => window.callService(name), name)
  for (const [name, path, fixture, message] of rejects) {
    next = [fixture]
    const result = await call(name)
    assert.equal(result.name, 'UnexpectedResponseError', `${name}: ${result.message}`)
    assert.match(result.message, message)
    assert.equal(requests.at(-1).path, path)
    assert.equal(next.length, 0)
  }

  // Un resultado incierto seguido por conflicto exige revisar la reserva existente.
  const from = requests.length
  next = [{ status: 201, json: { id: 'r1', lotId: 'l1', quantity: 0, status: 'confirmed', createdAt: at } },
    { status: 409, json: { error: { code: 'CONFLICT', message: 'Ya existe una reserva activa.' } } }]
  const ambiguous = await call('reserve')
  assert.equal(ambiguous.name, 'UnexpectedResponseError')
  assert.equal(ambiguous.uncertain, true)
  assert.match(ambiguous.message, /Puede que tu reserva ya se haya hecho/)
  assert.equal(requests.length - from, 2)
  for (const request of requests.slice(from)) {
    assert.equal(request.path, '/api/public/lots/l1/reservations')
    assert.deepEqual(JSON.parse(request.body), reservation, 'El reintento conserva la intención original')
  }

  for (const [status, body, message, uncertain] of [
    [409, { error: { code: 'CONFLICT', message: 'La incidencia ya cambió.' } }, 'La incidencia ya cambió.', false],
    [409, {}, 'La incidencia cambió. Actualiza antes de reintentar.', false],
    [422, {}, 'Revisa los textos: deben tener entre 1 y 2000 caracteres.', false],
    [429, {}, 'Hay demasiadas solicitudes. Espera antes de reintentar.', false],
    [503, {}, 'No fue posible completar la operación. Inténtalo nuevamente.', true],
  ]) {
    next = [{ status, json: body }]
    const result = await call('report')
    assert.equal(result.status, status)
    assert.equal(result.incidentMessage, message)
    assert.equal(result.uncertain, uncertain)
    assert.equal(requests.at(-1).method, 'POST')
    assert.deepEqual(JSON.parse(requests.at(-1).body), command)
  }
  console.log('Contratos web: respuestas inválidas, datos incoherentes, intención de reserva y errores de incidencias.')
} finally { await browser.close() }
