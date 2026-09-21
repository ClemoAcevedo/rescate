// K010 · Recorrido HTTP → Application → Domain con repositorio en memoria.
// No cubre SQL: la integración con PostgreSQL se prueba en scripts/test-lots.mjs.

import { assertContract } from "./support/openapi.js"
import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import type { Server } from "node:http"
import { createApp } from "../src/app.js"
import { createLotUseCases } from "../src/application/lots/use-cases.js"
import { createLotsRouter } from "../src/http/lots-router.js"
import type { Authenticate } from "../src/http/actor.js"
const noAuthentication: Authenticate = async () => null
const createDevActorAuthentication = (): Authenticate => async req => {
  const userId = req.header("x-rescate-dev-actor")
  return userId ? { userId } : null
}
import { createInMemoryLots } from "./support/in-memory-lots.js"
import type { InMemoryLots } from "./support/in-memory-lots.js"

const OPERATOR = "1"
const OTHER_OPERATOR = "2"
const ESTABLISHMENT = "11111111-1111-4111-8111-111111111111"
const OTHER_ESTABLISHMENT = "22222222-2222-4222-8222-222222222222"

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
  lots.establishments.set(ESTABLISHMENT, "10")
  lots.establishments.set(OTHER_ESTABLISHMENT, "20")
  lots.memberships.add(`${OPERATOR}:10`)
  lots.memberships.add(`${OTHER_OPERATOR}:20`)

  const useCases = createLotUseCases(lots, () => options.now ?? new Date("2026-09-21T12:00:00.000Z"))
  const app = createApp({
    lotsRouter: createLotsRouter({
      useCases,
      authenticate: options.authenticate === "none" ? noAuthentication : createDevActorAuthentication(),
      protectCommand: async () => {}, // Aislado: seguridad real se prueba con K008.
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
      const parsed = text === "" ? undefined : JSON.parse(text)
      assertContract(method, path, response, parsed)
      return { status: response.status, body: parsed }
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

  const created = await api.request("POST", `/establishments/${ESTABLISHMENT}/lots`, {
    body: { ...declaration({ conditions: "Retirar con bolsa propia" }) },
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
  assert.equal(created.body.establishmentId, ESTABLISHMENT)
  assert.equal(created.body.updatedAt, undefined)

  const published = await api.request("POST", `/lots/${created.body.id}/publish`, {
    body: { version: 1 },
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
    ["offset no es zona IANA", { timeZone: "+03:00" }, "time_zone_invalid"],
    ["latitud fuera de rango", { latitude: 91 }, "latitude_out_of_range"],
  ]

  for (const [label, override, violation] of cases) {
    const response = await api.request("POST", `/establishments/${ESTABLISHMENT}/lots`, {
      body: { ...declaration(override) },
    })
    assert.equal(response.status, 422, label)
    assert.equal(response.body.error.code, "VALIDATION_ERROR", label)
    assert.ok(response.body.error.details.issues.length > 0, label)
  }

  assert.equal(api.lots.lots.size, 0, "ningún borrador inválido se persiste")
})

test("rechaza cuerpos con forma inesperada antes de aplicar reglas", async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  for (const [label, body, field] of [
    ["cantidad como texto", { ...declaration({ quantity: "3" }) }, "quantity"],
    ["fecha sin zona", { ...declaration({ pickupStartsAt: "2026-10-01T15:00" }) }, "pickupStartsAt"],
    ["campo desconocido", { ...declaration(), status: "published" }, "status"],
  ] as const) {
    const response = await api.request("POST", `/establishments/${ESTABLISHMENT}/lots`, { body })
    assert.equal(response.status, 422, label)
    assert.equal(response.body.error.code, "VALIDATION_ERROR", label)
    assert.ok(response.body.error.details.issues.some((issue: any) => issue.path === `/${field}`), label)
  }
})

test("un operador ajeno no consulta, edita ni publica el lote", async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  const created = await api.request("POST", `/establishments/${ESTABLISHMENT}/lots`, {
    body: { ...declaration() },
  })
  const id = created.body.id

  for (const [method, path, body] of [
    ["GET", `/lots/${id}`, undefined],
    ["PATCH", `/lots/${id}`, { version: 1, ...declaration({ quantity: 99 }) }],
    ["POST", `/lots/${id}/publish`, { version: 1 }],
  ] as const) {
    const response = await api.request(method, path, { body, actor: OTHER_OPERATOR })
    // OpenAPI exige FORBIDDEN sin datos del lote.
    assert.equal(response.status, 403, `${method} ${path}`)
    assert.equal(response.body.error.code, "FORBIDDEN")
  }

  assert.equal(api.lots.lots.get(id)?.declaration.quantity, 3, "el lote ajeno no cambió")
  assert.equal(api.lots.lots.get(id)?.status, "draft")
})

test("sin sesión válida ninguna operación procede", async (t) => {
  const api = await startApi({ authenticate: "none" })
  t.after(() => api.close())

  const response = await api.request("POST", `/establishments/${ESTABLISHMENT}/lots`, {
    body: { ...declaration() },
  })
  assert.equal(response.status, 401)
  assert.equal(response.body.error.code, "UNAUTHENTICATED")
})

test("la versión optimista protege la edición concurrente del borrador", async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  const created = await api.request("POST", `/establishments/${ESTABLISHMENT}/lots`, {
    body: { ...declaration() },
  })
  const id = created.body.id

  const first = await api.request("PATCH", `/lots/${id}`, {
    body: { version: 1, quantity: 5 },
  })
  assert.equal(first.status, 200)
  assert.equal(first.body.quantity, 5)
  assert.equal(first.body.version, 2)
  assert.equal(first.body.description, created.body.description)
  assert.equal(first.body.pickupEndsAt, created.body.pickupEndsAt)

  // Segunda edición con la versión ya superada: se rechaza sin sobrescribir.
  const stale = await api.request("PATCH", `/lots/${id}`, {
    body: { version: 1, ...declaration({ quantity: 9 }) },
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.code, "CONFLICT")
  assert.equal(api.lots.lots.get(id)?.declaration.quantity, 5)
})

test("un lote publicado no se edita ni se vuelve a publicar", async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  const created = await api.request("POST", `/establishments/${ESTABLISHMENT}/lots`, {
    body: { ...declaration() },
  })
  const id = created.body.id
  await api.request("POST", `/lots/${id}/publish`, { body: { version: 1 } })

  const edit = await api.request("PATCH", `/lots/${id}`, {
    body: { version: 2, ...declaration({ quantity: 99 }) },
  })
  assert.equal(edit.status, 409)
  assert.equal(edit.body.error.code, "CONFLICT")

  const again = await api.request("POST", `/lots/${id}/publish`, { body: { version: 2 } })
  assert.equal(again.status, 409)
  assert.equal(again.body.error.code, "CONFLICT")

  const lot = api.lots.lots.get(id)
  assert.equal(lot?.declaration.quantity, 3)
  assert.equal(lot?.version, 2)
})

test("no se publica un lote cuya ventana ya terminó", async (t) => {
  const api = await startApi({ now: new Date("2026-10-02T12:00:00.000Z") })
  t.after(() => api.close())

  const created = await api.request("POST", `/establishments/${ESTABLISHMENT}/lots`, {
    body: { ...declaration() },
  })
  const response = await api.request("POST", `/lots/${created.body.id}/publish`, {
    body: { version: 1 },
  })

  assert.equal(response.status, 422)
  assert.equal(response.body.error.code, "VALIDATION_ERROR")
})

test("un lote inexistente responde 404 y un identificador inválido no filtra detalles", async (t) => {
  const api = await startApi()
  t.after(() => api.close())

  for (const id of ["11111111-1111-4111-8111-111111111111", "no-es-uuid"]) {
    const response = await api.request("GET", `/lots/${id}`)
    assert.equal(response.status, 404, id)
    assert.equal(response.body.error.code, "NOT_FOUND", id)
  }
})


test("creación exige ID público existente y membership; consulta propia", async (t) => {
  const api = await startApi()
  t.after(() => api.close())
  const forbidden = await api.request("POST", `/establishments/${ESTABLISHMENT}/lots`, { body: declaration(), actor: OTHER_OPERATOR })
  assert.equal(forbidden.status, 403)
  for (const id of ["10", "33333333-3333-4333-8333-333333333333"]) {
    assert.equal((await api.request("POST", `/establishments/${id}/lots`, { body: declaration() })).status, 404)
  }
  const created = await api.request("POST", `/establishments/${ESTABLISHMENT}/lots`, { body: declaration() })
  assert.deepEqual((await api.request("GET", `/lots/${created.body.id}`)).body, created.body)
})

test("PATCH distingue omitido/null, revalida ventana y rechaza propiedades extra", async (t) => {
  const api = await startApi()
  t.after(() => api.close())
  const created = await api.request("POST", `/establishments/${ESTABLISHMENT}/lots`, { body: declaration({ conditions: "Bolsa" }) })
  const path = `/lots/${created.body.id}`
  const edited = await api.request("PATCH", path, { body: { version: 1, quantity: 4 } })
  assert.equal(edited.body.conditions, "Bolsa")
  assert.equal(edited.body.description, created.body.description)
  const cleared = await api.request("PATCH", path, { body: { version: 2, conditions: null } })
  assert.equal(cleared.body.conditions, null)
  const noOp = await api.request("PATCH", path, { body: { version: 3, quantity: 4 } })
  assert.equal(noOp.body.version, 4)
  for (const body of [
    { version: 4 }, { version: 4, description: null }, { version: 4, status: "published" },
    { version: 4, establishmentId: OTHER_ESTABLISHMENT }, { expectedVersion: 4, quantity: 9 },
    { version: 4, pickupStartsAt: "2026-10-01T18:00:00Z" },
    { version: 4, pickupStartsAt: "2026-02-30T18:00:00Z" },
    { version: 4, pickupStartsAt: "2026-10-01T24:00:00Z" },
  ]) assert.equal((await api.request("PATCH", path, { body })).status, 422)
  assert.equal((await api.request("POST", `${path}/publish`, { body: { version: 4, quantity: 9 } })).status, 422)
  assert.deepEqual((await api.request("GET", path)).body, noOp.body)
  assert.equal((await api.request("POST", `/establishments/${ESTABLISHMENT}/lots`, { body: declaration({ id: "owned" }) })).status, 422)
})

test("transporte: JSON ilegible, tamaño, media type y tipos semánticos", async (t) => {
  const api = await startApi()
  t.after(() => api.close())
  const path = `/establishments/${ESTABLISHMENT}/lots`
  for (const [raw, contentType, status, code] of [
    ["{", "application/json", 400, "MALFORMED_REQUEST"],
    [JSON.stringify(declaration({ description: "x".repeat(17000) })), "application/json", 413, "PAYLOAD_TOO_LARGE"],
    ["{}", "text/plain", 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["null", "application/json", 422, "VALIDATION_ERROR"],
  ] as const) {
    const response = await fetch(`${api.url}${path}`, { method: "POST", headers: { "content-type": contentType, "x-rescate-dev-actor": OPERATOR }, body: raw })
    const body = await response.json()
    assert.equal(response.status, status)
    assert.equal(body.error.code, code)
    assertContract("POST", path, response, body)
  }
  for (const [method, oldPath] of [["GET", "/lots"], ["POST", "/lots"], ["POST", "/lots/id/publication"]]) {
    assert.equal((await fetch(`${api.url}${oldPath}`, { method })).status, 404)
  }
})


test("errores internos/disponibilidad no filtran diagnósticos y respetan OpenAPI", async (t) => {
  const api = await startApi()
  t.after(() => api.close())
  for (const [error, status, code] of [
    [new Error("SELECT secreto FROM tabla_interna"), 500, "INTERNAL_ERROR"],
    [Object.assign(new Error("host y credenciales internas"), { code: "ECONNREFUSED" }), 503, "SERVICE_UNAVAILABLE"],
  ] as const) {
    api.lots.findByPublicId = async () => { throw error }
    const response = await api.request("GET", "/lots/id-publico")
    assert.equal(response.status, status)
    assert.equal(response.body.error.code, code)
    assert.equal(JSON.stringify(response.body).includes(error.message), false)
  }
})
