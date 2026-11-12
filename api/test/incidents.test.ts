import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { IncidentRuleError, normalizeIncidentInstructions, normalizeIncidentReason, planIncidentClosure,
  requireIncidentTransition } from '../src/domain/incidents.js'
import { createIncidentUseCases } from '../src/application/incidents/use-cases.js'
import type { EstablishmentIncidentView, IncidentCommand, IncidentRepository, IncidentState, IncidentVersionResult } from '../src/application/incidents/ports.js'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/app.js'
import { createIncidentsRouter } from '../src/http/incidents-router.js'
import { assertContract } from './support/openapi.js'

const actor = { userId: '7' }
const incidentId = '00000000-0000-4000-8000-000000000001'
const command = (extra: Partial<IncidentCommand> = {}): IncidentCommand => ({ action: 'publish', version: 0,
  reason: 'Motivo', instructions: 'Instrucciones', idempotencyKey: randomUUID(), ...extra })
const published: IncidentVersionResult = { incidentId, version: 1, status: 'open', reason: 'Motivo',
  instructions: 'Instrucciones', publishedAt: '2030-01-01T12:00:00.000Z', closeLot: false, lotClosed: false }

function repository({ state = { status: 'reported', version: 0 } as Pick<IncidentState, 'status' | 'version'> | null, member = true,
  prior = null as IncidentVersionResult | null, memberAfterLock = member } = {}) {
  const calls = { locked: 0, published: 0, closed: 0 }
  const fake: IncidentRepository = {
    findLot: async () => ({ establishmentId: '1' }),
    findIncident: async () => ({ establishmentId: '1' }),
    isMember: async () => member,
    listByLot: async () => [],
    findEstablishment: async () => '1',
    listByEstablishment: async () => ({ items: [], hasNextPage: false }),
    withReport: async () => { throw new Error('no usado') },
    async withCommand(_user, _incident, _key, operate) {
      calls.locked++
      return operate(state && { ...state, lot: { id: incidentId, status: 'published', pickupEndsAt: new Date('2030-01-02'), reconciled: true }, at: new Date('2030-01-01') }, {
        isMember: async () => memberAfterLock,
        closeLot: async () => { calls.closed++ },
        prior: async () => prior,
        publish: async () => { calls.published++; return published },
      })
    },
  }
  return { fake, calls }
}

test('solo se publica un reporte; solo lo abierto se actualiza o resuelve; resuelta es terminal', () => {
  assert.equal(requireIncidentTransition('reported', 'publish'), 'open')
  assert.equal(requireIncidentTransition('open', 'update'), 'following')
  assert.equal(requireIncidentTransition('following', 'update'), 'following')
  assert.equal(requireIncidentTransition('open', 'resolve'), 'resolved')
  assert.equal(requireIncidentTransition('following', 'resolve'), 'resolved')
  for (const [status, action] of [['reported', 'update'], ['reported', 'resolve'], ['open', 'publish'], ['following', 'publish'],
    ['resolved', 'publish'], ['resolved', 'update'], ['resolved', 'resolve']] as const) {
    assert.throws(() => requireIncidentTransition(status, action), (error: unknown) =>
      error instanceof IncidentRuleError && error.reason === 'invalid_transition')
  }
})

test('cerrar es explícito y la misma clave no permite cambiar esa decisión', async () => {
  const ordinary = repository()
  await createIncidentUseCases(ordinary.fake).command(actor, incidentId, command())
  assert.equal(ordinary.calls.closed, 0)
  const closing = repository()
  await createIncidentUseCases(closing.fake).command(actor, incidentId, command({ closeLot: true }))
  assert.equal(closing.calls.closed, 1)
  const replay = repository({ prior: { ...published, closeLot: true, lotClosed: true } })
  await createIncidentUseCases(replay.fake).command(actor, incidentId, command({ closeLot: true }))
  assert.equal(replay.calls.closed, 0)
  await assert.rejects(createIncidentUseCases(replay.fake).command(actor, incidentId, command({ closeLot: false })), { code: 'idempotency_conflict' })
})

test('el cierre de incidencia respeta el límite exclusivo y conserva cierres previos', () => {
  const end = new Date('2030-01-01T12:00:00Z'), before = new Date(end.getTime()-1)
  assert.deepEqual(planIncidentClosure('published', end, before), { status: 'withdrawn', at: before })
  assert.deepEqual(planIncidentClosure('published', end, end), { status: 'expired', at: end })
  assert.deepEqual(planIncidentClosure('published', end, new Date(end.getTime()+1)), { status: 'expired', at: end })
  assert.equal(planIncidentClosure('withdrawn', end, before), null)
  assert.equal(planIncidentClosure('expired', end, end), null)
  assert.throws(() => planIncidentClosure('draft', end, before), /unpublished_lot/)
})

test('motivo e instrucciones admiten de 1 a 2000 caracteres útiles y se recortan', () => {
  assert.equal(normalizeIncidentReason('  texto  '), 'texto')
  assert.equal(normalizeIncidentInstructions('x'.repeat(2000)).length, 2000)
  for (const value of ['', '   ', 'x'.repeat(2001), 'a\0b']) {
    assert.throws(() => normalizeIncidentReason(value), /invalid_reason/)
    assert.throws(() => normalizeIncidentInstructions(value), /invalid_instructions/)
  }
})

test('el operador ajeno se rechaza antes de competir por el bloqueo y sin revelar la incidencia', async () => {
  const { fake, calls } = repository({ member: false })
  await assert.rejects(createIncidentUseCases(fake).command(actor, incidentId, command()), { code: 'incident_not_found' })
  assert.equal(calls.locked, 0)
})

test('la membresía se vuelve a comprobar bajo el bloqueo', async () => {
  const { fake, calls } = repository({ memberAfterLock: false })
  await assert.rejects(createIncidentUseCases(fake).command(actor, incidentId, command()), { code: 'incident_not_found' })
  assert.equal(calls.published, 0)
})

test('versión desactualizada y transición inválida no escriben', async () => {
  const stale = repository({ state: { status: 'open', version: 1 } })
  await assert.rejects(createIncidentUseCases(stale.fake).command(actor, incidentId, command({ action: 'update', version: 0 })),
    { code: 'incident_version_conflict' })
  assert.equal(stale.calls.published, 0)
  const resolved = repository({ state: { status: 'resolved', version: 2 } })
  await assert.rejects(createIncidentUseCases(resolved.fake).command(actor, incidentId, command({ action: 'update', version: 2 })), /invalid_transition/)
  assert.equal(resolved.calls.published, 0)
})

test('un reintento idéntico devuelve el resultado original aunque la incidencia haya avanzado', async () => {
  const { fake, calls } = repository({ state: { status: 'resolved', version: 3 }, prior: published })
  assert.deepEqual(await createIncidentUseCases(fake).command(actor, incidentId, command()), published)
  assert.equal(calls.published, 0)
})

test('la misma clave con otros parámetros es un conflicto', async () => {
  for (const change of [{ reason: 'Otro' }, { instructions: 'Otras' }, { action: 'update', version: 0 }, { version: 1 }] as Partial<IncidentCommand>[]) {
    const { fake } = repository({ prior: published })
    await assert.rejects(createIncidentUseCases(fake).command(actor, incidentId, command(change)), { code: 'idempotency_conflict' })
  }
  const { fake } = repository({ prior: { ...published, incidentId: '00000000-0000-4000-8000-000000000002' } })
  await assert.rejects(createIncidentUseCases(fake).command(actor, incidentId, command()), { code: 'idempotency_conflict' })
})

const ESTABLISHMENT = '11111111-1111-4111-8111-111111111111'
const LOT = '33333333-3333-4333-8333-333333333333'
const versionOf = ({ incidentId: _id, ...version }: IncidentVersionResult) => version
const listed: EstablishmentIncidentView = { id: incidentId, status: 'open', version: 1, reportReason: 'Pan con moho',
  reportedAt: '2030-01-01T11:00:00.000Z', lot: { id: LOT, description: 'Pan del día' },
  versions: [{ ...versionOf(published), recipientCount: 3, publishedBy: 'operadora@example.test', notices: { pending: 1, generated: 1, read: 1 } }] }

test('K046: solo un operador actual lista las incidencias de su establecimiento', async () => {
  const queries: unknown[] = []
  const base = repository().fake
  const fake: IncidentRepository = { ...base,
    findEstablishment: async id => id === ESTABLISHMENT ? '10' : null,
    isMember: async (_user, establishment) => establishment === '10',
    listByEstablishment: async (id, query) => { queries.push([id, query]); return { items: [listed], hasNextPage: true } },
  }
  const cases = createIncidentUseCases(fake)
  await assert.rejects(cases.listByEstablishment(actor, '22222222-2222-4222-8222-222222222222', { page: 1 }), { code: 'establishment_not_found' })
  await assert.rejects(createIncidentUseCases({ ...fake, isMember: async () => false }).listByEstablishment(actor, ESTABLISHMENT, { page: 1 }),
    { code: 'not_authorized' })
  assert.equal(queries.length, 0, 'no se consulta sin permiso')
  const page = await cases.listByEstablishment(actor, ESTABLISHMENT.toUpperCase(), { status: 'open', page: 2 })
  assert.deepEqual(page, { items: [listed], page: 2, hasNextPage: true })
  assert.deepEqual(queries, [['10', { status: 'open', page: 2 }]])
})

test('K046 · HTTP: incidencias del establecimiento según contrato y consulta estricta', async () => {
  const base = repository().fake
  const app = createApp({ incidentsRouter: createIncidentsRouter(createIncidentUseCases({ ...base,
    findEstablishment: async id => id === ESTABLISHMENT ? '10' : null,
    listByEstablishment: async () => ({ items: [listed], hasNextPage: false }),
  }), async () => ({ userId: '7' }), async () => {}, () => {}) })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (path: string) => {
    const response = await fetch(origin + path)
    const body = await response.json()
    assertContract('GET', path, response, body)
    return { status: response.status, body }
  }
  try {
    const ok = await call(`/establishments/${ESTABLISHMENT}/incidents?status=open&page=1`)
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body.items[0].versions[0].notices, { pending: 1, generated: 1, read: 1 })
    assert.equal(ok.body.items[0].versions[0].publishedBy, 'operadora@example.test')
    assert.equal((await call('/establishments/22222222-2222-4222-8222-222222222222/incidents')).status, 404)
    for (const [query, field] of [['status=closed', '/status'], ['page=0', '/page'], ['lotId=x', '/lotId'],
      ['status=open&status=resolved', '/status']] as const) {
      const invalid = await call(`/establishments/${ESTABLISHMENT}/incidents?${query}`)
      assert.equal(invalid.status, 422, query)
      assert.deepEqual(invalid.body.error.details.issues.map((issue: { path: string }) => issue.path), [field], query)
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
