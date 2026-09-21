// K010 · Domain: reglas puras de publicación de lotes (RF02).
// No conoce HTTP, Express, pg, entorno ni almacenamiento. Recibe el instante
// relevante como parámetro: no lee el reloj del sistema para decidir vigencia.

export type LotStatus = "draft" | "published"

/** Datos declarados por el operador. Son los campos que describen la oferta. */
export interface LotDeclaration {
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
  declaration: LotDeclaration
  createdAt: Date
  updatedAt: Date
  publishedAt: Date | null
}

/** Motivos por los que una declaración o una transición no es válida. */
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
 * Normaliza una declaración recortando espacios. No decide si es válida:
 * `checkDeclaration` responde eso por separado.
 */
export function normalizeDeclaration(declaration: LotDeclaration): LotDeclaration {
  const conditions = declaration.conditions === null ? null : declaration.conditions.trim()
  return {
    ...declaration,
    description: declaration.description.trim(),
    category: declaration.category.trim(),
    address: declaration.address.trim(),
    timeZone: declaration.timeZone.trim(),
    // Condiciones vacías equivalen a no declararlas (modelo K003: NULL).
    conditions: conditions === null || conditions === "" ? null : conditions,
  }
}

/** Devuelve todas las reglas incumplidas por una declaración ya normalizada. */
export function checkDeclaration(declaration: LotDeclaration): LotRuleViolation[] {
  const violations: LotRuleViolation[] = []

  if (isBlank(declaration.description)) violations.push("description_required")
  else if ([...declaration.description].length > DESCRIPTION_MAX_LENGTH) violations.push("description_too_long")

  if (isBlank(declaration.category)) {
    violations.push("category_required")
  }

  if (!Number.isInteger(declaration.quantity)) violations.push("quantity_not_integer")
  else if (declaration.quantity < 1 || declaration.quantity > QUANTITY_MAX) violations.push("quantity_out_of_range")


  if (isBlank(declaration.address)) {
    violations.push("address_required")
  }

  if (!Number.isFinite(declaration.latitude) || declaration.latitude < -90 || declaration.latitude > 90) {
    violations.push("latitude_out_of_range")
  }

  if (!Number.isFinite(declaration.longitude) || declaration.longitude < -180 || declaration.longitude > 180) {
    violations.push("longitude_out_of_range")
  }

  if (!isValidTimeZone(declaration.timeZone)) violations.push("time_zone_invalid")

  if (
    !isUsableDate(declaration.pickupStartsAt) ||
    !isUsableDate(declaration.pickupEndsAt) ||
    declaration.pickupEndsAt.getTime() <= declaration.pickupStartsAt.getTime()
  ) {
    violations.push("pickup_window_invalid")
  }

  return violations
}

/** Normaliza y exige que la declaración cumpla todas las reglas. */
export function declareLot(declaration: LotDeclaration): LotDeclaration {
  const normalized = normalizeDeclaration(declaration)
  const violations = checkDeclaration(normalized)
  if (violations.length > 0) throw new LotRuleError(violations)
  return normalized
}

/**
 * RF02: publicado el lote no cambian cantidad, contenido, lugar ni plazo. Para
 * corregirlos se retira y se crea otro. Editar solo es posible en borrador.
 */
export function declareDraftEdit(lot: Lot, declaration: LotDeclaration): LotDeclaration {
  if (lot.status !== "draft") throw new LotRuleError(["published_lot_is_immutable"])
  return declareLot(declaration)
}

/**
 * RF02 y H p. 20: se reserva desde la publicación hasta el cierre. Publicar un
 * lote cuya ventana ya terminó dejaría una oferta que nadie puede retirar.
 */
export function checkPublication(lot: Lot, now: Date): LotRuleViolation[] {
  const violations: LotRuleViolation[] = []
  if (lot.status === "published") violations.push("lot_already_published")
  violations.push(...checkDeclaration(lot.declaration))
  if (lot.declaration.pickupEndsAt.getTime() <= now.getTime()) violations.push("pickup_window_already_ended")
  return violations
}

/** Transición borrador → publicado. Devuelve el lote publicado. */
export function publishLot(lot: Lot, now: Date): Lot {
  const violations = checkPublication(lot, now)
  if (violations.length > 0) throw new LotRuleError(violations)
  return { ...lot, status: "published", publishedAt: now, updatedAt: now }
}
