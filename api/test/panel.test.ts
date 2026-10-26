// K035 · Período y tasas del panel, casos de uso con repositorio en memoria y transporte
// HTTP contra OpenAPI. El SQL se prueba con PostgreSQL real en scripts/test-panel.mjs.
import test from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { createApp } from "../src/app.js"
import type { ApplicationError } from "../src/application/errors.js"
import type { OpenLot, OperatorCommitment, PanelRepository, PeriodCounts } from "../src/application/panel/ports.js"
import { createPanelUseCases } from "../src/application/panel/use-cases.js"
import { PeriodRuleError, localDate, rate, resolvePeriod } from "../src/domain/panel.js"
import { createPanelRouter } from "../src/http/panel-router.js"
import { assertContract } from "./support/openapi.js"

const ESTABLISHMENT = "11111111-1111-4111-8111-111111111111"
const OTHER_ESTABLISHMENT = "22222222-2222-4222-8222-222222222222"
const LOT = "33333333-3333-4333-8333-333333333333"
const OTHER_LOT = "44444444-4444-4444-8444-444444444444"
// 23:30 del 15 de enero en Santiago (UTC-3 en verano): el día local sigue siendo el 15.
const NOW = new Date("2030-01-16T02:30:00Z")

const openLot = (overrides: Partial<OpenLot> = {}): OpenLot => ({
  publicId: LOT, description: "Pan del día", quantity: 10,
  pickupStartsAt: new Date("2030-01-15T20:00:00Z"), pickupEndsAt: new Date("2030-01-16T04:00:00Z"),
  inventory: { free: 3, offered: 2, reserved: 3, delivered: 1, unassignable: 1 },
  confirmedReservations: 2, activeOffers: 1, waitingRequests: 4, ...overrides,
})

const counts: PeriodCounts = {
  closedLots: 2, publishedPacks: 20, deliveredPacks: 12, unassignablePacks: 8,
  reservations: { confirmed: 10, cancelled: 2, expired: 3, delivered: 5 },
  excluded: { openLots: 2, draftLots: 1 },
}

function repository(overrides: Partial<PanelRepository> = {}): PanelRepository & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    async findEstablishment(publicId) {
      if (publicId === ESTABLISHMENT) return { id: "10", publicId, name: "Panadería del Barrio", timeZone: "America/Santiago" }
      if (publicId === OTHER_ESTABLISHMENT) return { id: "20", publicId, name: "Otro local", timeZone: "America/Santiago" }
      return null
    },
    async isMemberOfEstablishment(userId, establishmentId) { return userId === "1" && establishmentId === "10" },
    async findLot(establishmentId, lotPublicId) { return establishmentId === "10" && lotPublicId === LOT ? "100" : null },
    async readSummary(...args) {
      calls.push(["readSummary", ...args])
      return { openLots: [openLot(), openLot({ publicId: OTHER_LOT, inventory: { free: 0, offered: 0, reserved: 4, delivered: 2, unassignable: 0 },
        confirmedReservations: 3, activeOffers: 0, waitingRequests: 1 })], period: counts }
    },
    async listCommitments(...args) { calls.push(["listCommitments", ...args]); return { items: [], hasNextPage: false } },
    async listActivity(...args) { calls.push(["listActivity", ...args]); return { items: [], hasNextPage: false } },
    ...overrides,
  }
}

const failsWith = (code: string) => (error: unknown) => (error as ApplicationError).code === code

test("período: siete días con hoy incluido, una sola fecha, invertido y más de un año", () => {
  assert.deepEqual(resolvePeriod({}, "2030-01-15"), { from: "2030-01-09", to: "2030-01-15" })
  assert.deepEqual(resolvePeriod({ to: "2030-03-01" }, "2030-04-01"), { from: "2030-02-23", to: "2030-03-01" })
  assert.deepEqual(resolvePeriod({ from: "2030-01-01" }, "2030-01-15"), { from: "2030-01-01", to: "2030-01-15" })
  assert.deepEqual(resolvePeriod({ from: "2030-01-15", to: "2030-01-15" }, "2030-01-15"), { from: "2030-01-15", to: "2030-01-15" })
  // 2028 es bisiesto: del 1 de enero al 31 de diciembre son 366 días.
  assert.deepEqual(resolvePeriod({ from: "2028-01-01", to: "2028-12-31" }, "2030-01-15"), { from: "2028-01-01", to: "2028-12-31" })
  assert.throws(() => resolvePeriod({ from: "2030-01-16" }, "2030-01-15"), (error: PeriodRuleError) => error.violation === "period_inverted")
  assert.throws(() => resolvePeriod({ from: "2028-01-01", to: "2029-01-01" }, "2030-01-15"), (error: PeriodRuleError) => error.violation === "period_too_long")
})

test("día local en la zona del establecimiento y tasas sin denominador", () => {
  assert.equal(localDate(NOW, "America/Santiago"), "2030-01-15")
  assert.equal(localDate(NOW, "UTC"), "2030-01-16")
  assert.deepEqual(rate(3, 4), { numerator: 3, denominator: 4, value: 0.75 })
  assert.deepEqual(rate(0, 0), { numerator: 0, denominator: 0, value: null })
})

test("panel: solo su operador; totales como suma de los lotes abiertos y tasas con sus denominadores", async () => {
  const source = repository()
  const panel = createPanelUseCases(source, () => NOW)
  await assert.rejects(panel.getPanel({ userId: "2" }, ESTABLISHMENT, {}), failsWith("not_authorized"))
  await assert.rejects(panel.getPanel({ userId: "1" }, OTHER_ESTABLISHMENT, {}), failsWith("not_authorized"))
  await assert.rejects(panel.getPanel({ userId: "1" }, "inexistente", {}), failsWith("establishment_not_found"))
  assert.equal(source.calls.length, 0, "sin autorización no se lee nada")

  const result = await panel.getPanel({ userId: "1" }, ESTABLISHMENT, {})
  assert.deepEqual(source.calls[0], ["readSummary", "10", { from: "2030-01-09", to: "2030-01-15" }, "America/Santiago", NOW])
  assert.deepEqual(result.current.inventory, { free: 3, offered: 2, reserved: 7, delivered: 3, unassignable: 1 })
  assert.deepEqual([result.current.confirmedReservations, result.current.activeOffers, result.current.waitingRequests], [5, 1, 5])
  assert.deepEqual(result.period.deliveryRate, { numerator: 12, denominator: 20, value: 0.6 })
  assert.deepEqual(result.period.reservationExpiryRate, { numerator: 3, denominator: 10, value: 0.3 })
  assert.deepEqual(result.period.excluded, { openLots: 2, draftLots: 1 })
})

test("compromisos: estado vigente al responder y lote de otro establecimiento como inexistente", async () => {
  const base = { lot: { id: LOT, description: "Pan del día" }, createdAt: new Date("2030-01-15T10:00:00Z"), pickupEndsAt: new Date("2030-01-16T01:00:00Z") }
  const items: OperatorCommitment[] = [
    { ...base, publicId: "r1", kind: "reservation", status: "confirmed", quantity: 2, offeredQuantity: null, offerExpiresAt: null, endedAt: null },
    { ...base, publicId: "w1", kind: "waitlist", status: "offered", quantity: 3, offeredQuantity: 1,
      offerExpiresAt: new Date("2030-01-15T23:00:00Z"), endedAt: null },
    { ...base, publicId: "r2", kind: "reservation", status: "delivered", quantity: 1, offeredQuantity: null, offerExpiresAt: null,
      endedAt: new Date("2030-01-15T22:00:00Z") },
  ]
  const source = repository({ async listCommitments(...args) { source.calls.push(args); return { items, hasNextPage: true } } })
  const panel = createPanelUseCases(source, () => NOW)
  await assert.rejects(panel.listCommitments({ userId: "1" }, ESTABLISHMENT, { lotId: OTHER_LOT, page: 1 }), failsWith("lot_not_found"))
  const result = await panel.listCommitments({ userId: "1" }, ESTABLISHMENT, { lotId: LOT, page: 2, active: false })
  assert.deepEqual(source.calls[0], ["10", { lotId: "100", page: 2, active: false }, NOW])
  // La ventana cerró a las 01:00Z: la reserva venció con el cierre y la oferta a su hora.
  assert.deepEqual(result.items.map(item => [item.publicId, item.status, item.endedAt?.toISOString()]), [
    ["r1", "expired", "2030-01-16T01:00:00.000Z"],
    ["w1", "expired", "2030-01-15T23:00:00.000Z"],
    ["r2", "delivered", "2030-01-15T22:00:00.000Z"],
  ])
  assert.deepEqual([result.page, result.hasNextPage], [2, true])
})

async function start(source: PanelRepository, actor: string | null = "1") {
  const app = createApp({ panelRouter: createPanelRouter(createPanelUseCases(source, () => NOW), async () => actor === null ? null : { userId: actor }, () => {}) })
  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    async call(path: string) {
      const response = await fetch(`${base}${path}`)
      const body = await response.json()
      assertContract("GET", path, response, body)
      return { status: response.status, body }
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

test("HTTP: panel, compromisos e historial según contrato, sin códigos ni titulares", async () => {
  const source = repository({
    async listCommitments() {
      return { hasNextPage: false, items: [{ publicId: "55555555-5555-4555-8555-555555555555", kind: "waitlist", status: "waiting",
        lot: { id: LOT, description: "Pan del día" }, quantity: 2, offeredQuantity: null, offerExpiresAt: null,
        createdAt: new Date("2030-01-15T22:00:00Z"), endedAt: null, pickupEndsAt: new Date("2030-01-16T04:00:00Z") }] }
    },
    async listActivity() {
      return { hasNextPage: false, items: [{ id: `pickup_confirmed:${LOT}`, kind: "pickup_confirmed", at: new Date("2030-01-15T23:00:00Z"),
        lot: { id: LOT, description: "Pan del día" }, quantity: 2 }] }
    },
  })
  const api = await start(source)
  try {
    const panel = await api.call(`/establishments/${ESTABLISHMENT}/panel?from=2030-01-01&to=2030-01-15`)
    assert.equal(panel.status, 200)
    assert.deepEqual(panel.body.period.packs, { published: 20, delivered: 12, unassignable: 8 })
    assert.deepEqual([panel.body.period.from, panel.body.period.to], ["2030-01-01", "2030-01-15"])
    assert.equal(panel.body.current.lots.length, 2)
    const commitments = await api.call(`/establishments/${ESTABLISHMENT}/commitments?state=active&lotId=${LOT}&page=1`)
    assert.equal(commitments.body.items[0].status, "waiting")
    const activity = await api.call(`/establishments/${ESTABLISHMENT}/activity?lotId=${LOT}`)
    assert.equal(activity.body.items[0].kind, "pickup_confirmed")
    for (const body of [panel.body, commitments.body, activity.body]) {
      assert.doesNotMatch(JSON.stringify(body), /pickupCode|email|userId/)
    }

    const invalid = async (query: string, path: string) => {
      const result = await api.call(`/establishments/${ESTABLISHMENT}/${query}`)
      assert.equal(result.status, 422, query)
      assert.equal(result.body.error.details.issues[0].path, path, query)
    }
    await invalid("panel?from=2030-02-30", "/from")
    await invalid("panel?to=15-01-2030", "/to")
    await invalid("panel?from=2030-01-01&from=2030-01-02", "/from")
    await invalid("panel?desde=2030-01-01", "/desde")
    await invalid("panel?from=2030-01-16&to=2030-01-15", "/from")
    await invalid("panel?from=2028-01-01&to=2029-01-01", "/from")
    await invalid("commitments?state=todos", "/state")
    await invalid("commitments?page=0", "/page")
    await invalid("activity?page=1001", "/page")
    await invalid("activity?state=active", "/state")
    assert.equal((await api.call(`/establishments/${ESTABLISHMENT}/activity?lotId=${OTHER_LOT}`)).status, 404)
    assert.equal((await api.call(`/establishments/${OTHER_ESTABLISHMENT}/panel`)).status, 403)
    assert.equal((await api.call(`/establishments/${OTHER_LOT}/commitments`)).status, 404)
  } finally { await api.close() }

  const anonymous = await start(repository(), null)
  try {
    assert.equal((await anonymous.call(`/establishments/${ESTABLISHMENT}/panel`)).status, 401)
  } finally { await anonymous.close() }
})
