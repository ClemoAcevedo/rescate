// K010 · Domain: reglas puras, sin HTTP, base ni entorno.

import assert from "node:assert/strict"
import test from "node:test"
import {
  LotRuleError,
  checkDeclaration,
  declareDraftEdit,
  declareLot,
  normalizeDeclaration,
  publishLot,
} from "../src/domain/lots.js"
import type { Lot, LotDeclaration } from "../src/domain/lots.js"

const validDeclaration = (overrides: Partial<LotDeclaration> = {}): LotDeclaration => ({
  description: "Pack ficticio de verduras",
  category: "Verduras",
  quantity: 3,
  conditions: null,
  address: "Dirección ficticia 123",
  latitude: -33.45,
  longitude: -70.66,
  timeZone: "America/Santiago",
  pickupStartsAt: new Date("2026-10-01T15:00:00.000Z"),
  pickupEndsAt: new Date("2026-10-01T17:00:00.000Z"),
  ...overrides,
})

const draft = (overrides: Partial<Lot> = {}): Lot => ({
  publicId: "11111111-1111-4111-8111-111111111111",
  establishmentId: "1",
  establishmentPublicId: "est_test",
  status: "draft",
  version: 1,
  declaration: validDeclaration(),
  createdAt: new Date("2026-09-21T12:00:00.000Z"),
  updatedAt: new Date("2026-09-21T12:00:00.000Z"),
  publishedAt: null,
  ...overrides,
})

test("una declaración válida se acepta y se normaliza", () => {
  const declared = declareLot(validDeclaration({
    description: "  Pack ficticio de verduras  ",
    category: " Verduras ",
    conditions: "   ",
  }))

  assert.equal(declared.description, "Pack ficticio de verduras")
  assert.equal(declared.category, "Verduras")
  // Condiciones en blanco equivalen a no declararlas.
  assert.equal(declared.conditions, null)
})

test("la cantidad debe ser entera y positiva", () => {
  for (const [quantity, violation] of [
    [0, "quantity_out_of_range"],
    [-1, "quantity_out_of_range"],
    [1.5, "quantity_not_integer"],
    [2_147_483_648, "quantity_out_of_range"],
    [Number.NaN, "quantity_not_integer"],
  ] as const) {
    assert.deepEqual(checkDeclaration(validDeclaration({ quantity })), [violation], `cantidad ${quantity}`)
  }

  assert.deepEqual(checkDeclaration(validDeclaration({ quantity: 1 })), [])
  // H p. 18 usa 100 packs como supuesto de escala, no como límite del negocio.
  assert.deepEqual(checkDeclaration(validDeclaration({ quantity: 101 })), [])
})

test("la ventana de retiro debe terminar después de comenzar", () => {
  const start = new Date("2026-10-01T15:00:00.000Z")
  for (const pickupEndsAt of [start, new Date("2026-10-01T14:59:59.000Z"), new Date("no es fecha")]) {
    assert.deepEqual(
      checkDeclaration(validDeclaration({ pickupStartsAt: start, pickupEndsAt })),
      ["pickup_window_invalid"],
    )
  }
})

test("ubicación, zona horaria y textos se validan", () => {
  assert.deepEqual(checkDeclaration(validDeclaration({ latitude: 91 })), ["latitude_out_of_range"])
  assert.deepEqual(checkDeclaration(validDeclaration({ longitude: -181 })), ["longitude_out_of_range"])
  assert.deepEqual(checkDeclaration(validDeclaration({ timeZone: "Marte/Olympus" })), ["time_zone_invalid"])
  assert.deepEqual(checkDeclaration(validDeclaration({ description: "   " })), ["description_required"])
  assert.deepEqual(checkDeclaration(validDeclaration({ description: "x".repeat(2001) })), ["description_too_long"])
  assert.deepEqual(checkDeclaration(validDeclaration({ conditions: "x".repeat(2001) })), [])
  assert.deepEqual(checkDeclaration(validDeclaration({ category: " " })), ["category_required"])
})

test("se informan todas las reglas incumplidas, no solo la primera", () => {
  const violations = checkDeclaration(validDeclaration({ quantity: 0, category: "", latitude: 100 }))
  assert.deepEqual(violations.sort(), ["category_required", "latitude_out_of_range", "quantity_out_of_range"])
})

test("publicar un borrador válido fija estado e instante", () => {
  const now = new Date("2026-09-30T12:00:00.000Z")
  const published = publishLot(draft(), now)

  assert.equal(published.status, "published")
  assert.deepEqual(published.publishedAt, now)
  assert.deepEqual(published.updatedAt, now)
})

test("no se publica dos veces el mismo lote", () => {
  const lot = draft({ status: "published", publishedAt: new Date("2026-09-25T12:00:00.000Z") })
  assert.throws(
    () => publishLot(lot, new Date("2026-09-30T12:00:00.000Z")),
    (error: unknown) => error instanceof LotRuleError && error.violations.includes("lot_already_published"),
  )
})

test("no se publica un lote cuya ventana ya terminó", () => {
  const afterWindow = new Date("2026-10-01T17:00:00.000Z")
  assert.throws(
    () => publishLot(draft(), afterWindow),
    (error: unknown) => error instanceof LotRuleError && error.violations.includes("pickup_window_already_ended"),
  )
})

test("RF02: un lote publicado es inmutable", () => {
  const lot = draft({ status: "published", publishedAt: new Date("2026-09-25T12:00:00.000Z") })
  assert.throws(
    () => declareDraftEdit(lot, validDeclaration({ quantity: 10 })),
    (error: unknown) => error instanceof LotRuleError && error.violations.includes("published_lot_is_immutable"),
  )

  // El borrador sí admite corregir su declaración.
  assert.equal(declareDraftEdit(draft(), validDeclaration({ quantity: 10 })).quantity, 10)
})

test("normalizar no decide validez", () => {
  const normalized = normalizeDeclaration(validDeclaration({ description: "  ", quantity: 0 }))
  assert.equal(normalized.description, "")
  assert.deepEqual(checkDeclaration(normalized).sort(), ["description_required", "quantity_out_of_range"])
})
