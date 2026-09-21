// K010 · Recorrido HTTP → Application → Domain con repositorio en memoria.
// No cubre SQL: la integración con PostgreSQL se prueba en scripts/test-lots.mjs.

import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import type { Server } from "node:http"
import { createApp } from "../src/app.js"
import { createLotUseCases } from "../src/application/lots/use-cases.js"
import { createLotsRouter } from "../src/http/lots-router.js"
import { createDevActorAuthentication, noAuthentication, selectAuthentication } from "../src/http/actor.js"
import { createInMemoryLots } from "./support/in-memory-lots.js"
import type { InMemoryLots } from "./support/in-memory-lots.js"

const OPERATOR = "1"
const OTHER_OPERATOR = "2"
const ESTABLISHMENT = "10"
const OTHER_ESTABLISHMENT = "20"

const declaration = (overrides: Record<string, unknown> = {}) => ({
  description: "Pack ficticio de verduras",
  category: "Verduras",
  quantity: 3,
  address: "Dirección ficticia 123",
  latitude: -33.45,
  longitude: -70.66,
  timeZone: "America/Santiago",
  pickupStartsAt: "2026-10-01T15:00:00.000Z",
  pickupEndsAt: "2026-10-01T17:00:00.000Z",
  ...overrides,
})

interface Harness {
  url: string
  lots: InMemoryLots
  request(method: string, path: string, options?: { body?: unknown; actor?: string | null }): Promise<{
    status: number
    body: any
  }>
  close(): Promise<void>
}

async function startApi(options: { now?: Date; authenticate?: "dev" | "none" } = {}): Promise<Harness> {
  const lots = createInMemoryLots(() => options.now ?? new Date("2026-09-21T12:00:00.000Z"))
  lots.memberships.add(`${OPERATOR}:${ESTABLISHMENT}`)
  lots.memberships.add(`${OTHER_OPERATOR}:${OTHER_ESTABLISHMENT}`)

  const useCases = createLotUseCases(lots, () => options.now ?? new Date("2026-09-21T12:00:00.000Z"))
  const app = createApp({
    lotsRouter: createLotsRouter({
      useCases,
      authenticate: options.authenticate === "none" ? noAuthentication : createDevActorAuthentication(),
      log: () => {},
    }),
  })

  const server: Server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    lots,
    async request(method, path, { body, actor = OPERATOR } = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(actor === null ? {} : { "x-rescate-dev-actor": actor }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      return { status: response.status, body: text === "" ? undefined : JSON.parse(text) }
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    }),
  }
}

test("crea un borrador y lo publica", async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  const created = await api.request("POST", "/lots", {
    body: { establishmentId: ESTABLISHMENT, ...declaration({ conditions: "Retirar con bolsa propia" }) },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.status, "draft")
  assert.equal(created.body.version, 1)
  assert.equal(created.body.publishedAt, null)
  assert.equal(created.body.quantity, 3)
  assert.equal(created.body.conditions, "Retirar con bolsa propia")
  assert.match(created.body.id, /^[0-9a-f-]{36}$/)
  // El identificador interno bigint no se expone en el contrato HTTP.
  assert.equal(created.body.lotId, undefined)

  const published = await api.request("POST", `/lots/${created.body.id}/publication`, {
    body: { expectedVersion: 1 },
  })
  assert.equal(published.status, 200)
  assert.equal(published.body.status, "published")
  assert.equal(published.body.version, 2)
  assert.equal(published.body.publishedAt, "2026-09-21T12:00:00.000Z")
})

test("rechaza cantidades, ventanas y datos inválidos", async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["cantidad cero", { quantity: 0 }, "quantity_out_of_range"],
    ["cantidad fraccionaria", { quantity: 1.5 }, "quantity_not_integer"],
    ["ventana invertida", { pickupEndsAt: "2026-10-01T14:00:00.000Z" }, "pickup_window_invalid"],
    ["descripción vacía", { description: "   " }, "description_required"],
    ["zona horaria inexistente", { timeZone: "Marte/Olympus" }, "time_zone_invalid"],
    ["latitud fuera de rango", { latitude: 91 }, "latitude_out_of_range"],
  ]

  for (const [label, override, violation] of cases) {
    const response = await api.request("POST", "/lots", {
      body: { establishmentId: ESTABLISHMENT, ...declaration(override) },
    })
    assert.equal(response.status, 422, label)
    assert.equal(response.body.error.code, "invalid_lot", label)
    assert.ok(response.body.error.violations.includes(violation), `${label}: ${response.body.error.violations}`)
  }

  assert.equal(api.lots.lots.size, 0, "ningún borrador inválido se persiste")
})

test("rechaza cuerpos con forma inesperada antes de aplicar reglas", async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  for (const [label, body, field] of [
    ["cantidad como texto", { establishmentId: ESTABLISHMENT, ...declaration({ quantity: "3" }) }, "quantity"],
    ["fecha sin zona", { establishmentId: ESTABLISHMENT, ...declaration({ pickupStartsAt: "2026-10-01T15:00" }) }, "pickupStartsAt"],
    ["falta establecimiento", declaration(), "establishmentId"],
  ] as const) {
    const response = await api.request("POST", "/lots", { body })
    assert.equal(response.status, 400, label)
    assert.equal(response.body.error.code, "invalid_request", label)
    assert.ok(response.body.error.violations.includes(field), label)
  }
})

test("un operador ajeno no consulta, edita ni publica el lote", async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  const created = await api.request("POST", "/lots", {
    body: { establishmentId: ESTABLISHMENT, ...declaration() },
  })
  const id = created.body.id

  for (const [method, path, body] of [
    ["GET", `/lots/${id}`, undefined],
    ["PATCH", `/lots/${id}`, { expectedVersion: 1, ...declaration({ quantity: 99 }) }],
    ["POST", `/lots/${id}/publication`, { expectedVersion: 1 }],
  ] as const) {
    const response = await api.request(method, path, { body, actor: OTHER_OPERATOR })
    // 404 y no 403: no se confirma la existencia de un lote ajeno.
    assert.equal(response.status, 404, `${method} ${path}`)
    assert.equal(response.body.error.code, "not_authorized")
  }

  assert.equal(api.lots.lots.get(id)?.declaration.quantity, 3, "el lote ajeno no cambió")
  assert.equal(api.lots.lots.get(id)?.status, "draft")
})

test("sin sesión válida ninguna operación procede", async (t) => {
  const api = await startApi({ authenticate: "none" })
  t.after(() => api.close())

  const response = await api.request("POST", "/lots", {
    body: { establishmentId: ESTABLISHMENT, ...declaration() },
  })
  assert.equal(response.status, 401)
  assert.equal(response.body.error.code, "not_authenticated")
})

test("la versión optimista protege la edición concurrente del borrador", async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  const created = await api.request("POST", "/lots", {
    body: { establishmentId: ESTABLISHMENT, ...declaration() },
  })
  const id = created.body.id

  const first = await api.request("PATCH", `/lots/${id}`, {
    body: { expectedVersion: 1, ...declaration({ quantity: 5 }) },
  })
  assert.equal(first.status, 200)
  assert.equal(first.body.quantity, 5)
  assert.equal(first.body.version, 2)

  // Segunda edición con la versión ya superada: se rechaza sin sobrescribir.
  const stale = await api.request("PATCH", `/lots/${id}`, {
    body: { expectedVersion: 1, ...declaration({ quantity: 9 }) },
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.code, "version_conflict")
  assert.equal(api.lots.lots.get(id)?.declaration.quantity, 5)
})

test("un lote publicado no se edita ni se vuelve a publicar", async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  const created = await api.request("POST", "/lots", {
    body: { establishmentId: ESTABLISHMENT, ...declaration() },
  })
  const id = created.body.id
  await api.request("POST", `/lots/${id}/publication`, { body: { expectedVersion: 1 } })

  const edit = await api.request("PATCH", `/lots/${id}`, {
    body: { expectedVersion: 2, ...declaration({ quantity: 99 }) },
  })
  assert.equal(edit.status, 409)
  assert.equal(edit.body.error.code, "lot_state_conflict")
  assert.ok(edit.body.error.violations.includes("published_lot_is_immutable"))

  const again = await api.request("POST", `/lots/${id}/publication`, { body: { expectedVersion: 2 } })
  assert.equal(again.status, 409)
  assert.ok(again.body.error.violations.includes("lot_already_published"))

  const lot = api.lots.lots.get(id)
  assert.equal(lot?.declaration.quantity, 3)
  assert.equal(lot?.version, 2)
})

test("no se publica un lote cuya ventana ya terminó", async (t) => {
  const api = await startApi({ now: new Date("2026-10-02T12:00:00.000Z") })
  t.after(() => api.close())

  const created = await api.request("POST", "/lots", {
    body: { establishmentId: ESTABLISHMENT, ...declaration() },
  })
  const response = await api.request("POST", `/lots/${created.body.id}/publication`, {
    body: { expectedVersion: 1 },
  })

  assert.equal(response.status, 409)
  assert.ok(response.body.error.violations.includes("pickup_window_already_ended"))
})

test("un lote inexistente responde 404 y un identificador inválido no filtra detalles", async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  for (const id of ["11111111-1111-4111-8111-111111111111", "no-es-uuid"]) {
    const response = await api.request("GET", `/lots/${id}`)
    assert.equal(response.status, 404, id)
    assert.equal(response.body.error.code, "lot_not_found", id)
  }
})

test("el panel lista solo los lotes del establecimiento propio", async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  const first = await api.request("POST", "/lots", {
    body: { establishmentId: ESTABLISHMENT, ...declaration({ description: "Primer pack" }) },
  })
  await api.request("POST", "/lots", {
    body: { establishmentId: ESTABLISHMENT, ...declaration({ description: "Segundo pack" }) },
  })
  await api.request("POST", `/lots/${first.body.id}/publication`, { body: { expectedVersion: 1 } })

  const all = await api.request("GET", `/lots?establishmentId=${ESTABLISHMENT}`)
  assert.equal(all.status, 200)
  assert.equal(all.body.items.length, 2)

  const drafts = await api.request("GET", `/lots?establishmentId=${ESTABLISHMENT}&status=draft`)
  assert.equal(drafts.body.items.length, 1)
  assert.equal(drafts.body.items[0].description, "Segundo pack")

  const foreign = await api.request("GET", `/lots?establishmentId=${OTHER_ESTABLISHMENT}`)
  assert.equal(foreign.status, 404)
  assert.equal(foreign.body.error.code, "not_authorized")
})

test("el actor de desarrollo está deshabilitado salvo decisión explícita", () => {
  assert.equal(selectAuthentication({}), noAuthentication)
  assert.equal(selectAuthentication({ RESCATE_DEV_ACTOR: "" }), noAuthentication)
  assert.notEqual(selectAuthentication({ RESCATE_DEV_ACTOR: "enabled" }), noAuthentication)
  assert.throws(
    () => selectAuthentication({ RESCATE_DEV_ACTOR: "enabled", NODE_ENV: "production" }),
    /NODE_ENV=production/,
  )
})
