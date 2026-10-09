// K010 · Domain: reglas puras de publicación de lotes (RF02).
// No conoce HTTP, Express, pg, entorno ni almacenamiento. Recibe el instante
// relevante como parámetro: no lee el reloj del sistema para decidir vigencia.

import { allPhotosReady } from "./photos.js"
import type { PhotoStatus } from "./photos.js"

/** Vencido y retirado cierran el lote sin borrarlo (ADR 0008); conserva fotos, reservas e inventario. */
export const LOT_STATUSES = ["draft", "published", "expired", "withdrawn"] as const
export type LotStatus = (typeof LOT_STATUSES)[number]

/** Descripción del lote: los campos que el operador completa para la oferta. */
export interface LotDescription {
  description: string
  category: string
  quantity: number
  conditions: string | null
  address: string
  latitude: number
  longitude: number
  timeZone: string
  pickupStartsAt: Date
  pickupEndsAt: Date
}

export interface Lot {
  publicId: string
  /** Clave interna para autorización, nunca se expone por HTTP. */
  establishmentId: string
  establishmentPublicId: string
  status: LotStatus
  version: number
  description: LotDescription
  createdAt: Date
  updatedAt: Date
  publishedAt: Date | null
}

/** Motivos por los que una descripción o una transición no es válida. */
export type LotRuleViolation =
  | "description_required"
  | "description_too_long"
  | "category_required"
  | "quantity_not_integer"
  | "quantity_out_of_range"
  | "address_required"
  | "latitude_out_of_range"
  | "longitude_out_of_range"
  | "time_zone_invalid"
  | "pickup_window_invalid"
  | "pickup_window_already_ended"
  | "lot_already_published"
  | "published_lot_is_immutable"
  | "photo_not_ready"

export class LotRuleError extends Error {
  readonly violations: readonly LotRuleViolation[]

  constructor(violations: readonly LotRuleViolation[]) {
    super(`Reglas de lote incumplidas: ${violations.join(", ")}`)
    this.name = "LotRuleError"
    this.violations = violations
  }
}

// H p. 20 y OpenAPI: descripción de hasta 2000 caracteres.
export const DESCRIPTION_MAX_LENGTH = 2000

// integer de PostgreSQL. La cantidad publicada Q es entera y positiva (B p. 4).
export const QUANTITY_MAX = 2_147_483_647

function isBlank(value: string): boolean {
  return value.trim().length === 0
}

function isValidTimeZone(timeZone: string): boolean {
  if (isBlank(timeZone) || /^[+-]/.test(timeZone)) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone })
    return true
  } catch {
    return false
  }
}

function isUsableDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime())
}

/**
 * Normaliza una descripción recortando espacios. No decide si es válida:
 * `checkDescription` responde eso por separado.
 */
export function normalizeDescription(description: LotDescription): LotDescription {
  const conditions = description.conditions === null ? null : description.conditions.trim()
  return {
    ...description,
    description: description.description.trim(),
    category: description.category.trim(),
    address: description.address.trim(),
    timeZone: description.timeZone.trim(),
    // Condiciones vacías equivalen a no declararlas (modelo K003: NULL).
    conditions: conditions === null || conditions === "" ? null : conditions,
  }
}

/** Devuelve todas las reglas incumplidas por una descripción ya normalizada. */
export function checkDescription(description: LotDescription): LotRuleViolation[] {
  const violations: LotRuleViolation[] = []

  if (isBlank(description.description)) violations.push("description_required")
  else if ([...description.description].length > DESCRIPTION_MAX_LENGTH) violations.push("description_too_long")

  if (isBlank(description.category)) {
    violations.push("category_required")
  }

  if (!Number.isInteger(description.quantity)) violations.push("quantity_not_integer")
  else if (description.quantity < 1 || description.quantity > QUANTITY_MAX) violations.push("quantity_out_of_range")


  if (isBlank(description.address)) {
    violations.push("address_required")
  }

  if (!Number.isFinite(description.latitude) || description.latitude < -90 || description.latitude > 90) {
    violations.push("latitude_out_of_range")
  }

  if (!Number.isFinite(description.longitude) || description.longitude < -180 || description.longitude > 180) {
    violations.push("longitude_out_of_range")
  }

  if (!isValidTimeZone(description.timeZone)) violations.push("time_zone_invalid")

  if (
    !isUsableDate(description.pickupStartsAt) ||
    !isUsableDate(description.pickupEndsAt) ||
    description.pickupEndsAt.getTime() <= description.pickupStartsAt.getTime()
  ) {
    violations.push("pickup_window_invalid")
  }

  return violations
}

/** Normaliza y exige que la descripción cumpla todas las reglas. */
export function describeLot(description: LotDescription): LotDescription {
  const normalized = normalizeDescription(description)
  const violations = checkDescription(normalized)
  if (violations.length > 0) throw new LotRuleError(violations)
  return normalized
}

/**
 * RF02: publicado el lote no cambian cantidad, contenido, lugar ni plazo. Para
 * corregirlos se retira y se crea otro. Editar solo es posible en borrador.
 */
export function describeDraftEdit(lot: Lot, description: LotDescription): LotDescription {
  if (lot.status !== "draft") throw new LotRuleError(["published_lot_is_immutable"])
  return describeLot(description)
}

/**
 * RF02 y H p. 20: se reserva desde la publicación hasta el cierre. Publicar un
 * lote cuya ventana ya terminó dejaría una oferta que nadie puede retirar.
 */
export function checkPublication(lot: Lot, now: Date, photos: readonly PhotoStatus[] = []): LotRuleViolation[] {
  const violations: LotRuleViolation[] = []
  if (lot.status !== "draft") violations.push("lot_already_published")
  violations.push(...checkDescription(lot.description))
  if (lot.description.pickupEndsAt.getTime() <= now.getTime()) violations.push("pickup_window_already_ended")
  // Cero fotos es válido. Una foto en carga, validación o rechazada impide publicar:
  // las fotos quedan fijas y omitirlas cambiaría lo que el operador revisó (D-05).
  if (!allPhotosReady(photos)) violations.push("photo_not_ready")
  return violations
}

/** Transición borrador → publicado. Recibe el estado de sus fotos activas. */
export function publishLot(lot: Lot, now: Date, photos: readonly PhotoStatus[] = []): Lot {
  const violations = checkPublication(lot, now, photos)
  if (violations.length > 0) throw new LotRuleError(violations)
  return { ...lot, status: "published", publishedAt: now, updatedAt: now }
}
