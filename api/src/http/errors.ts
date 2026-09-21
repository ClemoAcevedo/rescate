// K010 · HTTP: traducción de errores semánticos al contrato. Infrastructure no
// elige códigos y las respuestas no exponen SQL, stack ni detalles internos.

import type { Response } from "express"
import { ApplicationError } from "../application/errors.js"
import { LotRuleError } from "../domain/lots.js"

export interface ErrorBody {
  error: {
    code: string
    message: string
    /** Reglas incumplidas, cuando la entrada es inválida para el negocio. */
    violations?: readonly string[]
  }
}

export function sendError(
  response: Response,
  status: number,
  code: string,
  message: string,
  violations?: readonly string[],
): void {
  const body: ErrorBody = { error: { code, message } }
  if (violations !== undefined && violations.length > 0) body.error.violations = violations
  response.status(status).json(body)
}

const STATUS_BY_CODE = {
  not_authenticated: 401,
  // Un lote ajeno responde 404: no se confirma la existencia de datos de otro
  // establecimiento a quien no está autorizado a verlos.
  not_authorized: 404,
  lot_not_found: 404,
  version_conflict: 409,
} as const

const MESSAGE_BY_CODE = {
  not_authenticated: "La operación requiere una sesión válida.",
  not_authorized: "No se encontró el lote.",
  lot_not_found: "No se encontró el lote.",
  version_conflict: "El lote cambió desde su última lectura. Vuelve a cargarlo antes de reintentar.",
} as const

/**
 * Reglas sobre el estado del lote o el instante de la operación, no sobre la
 * forma de los datos: la declaración pudo ser válida al guardarse.
 */
const CONFLICT_VIOLATIONS = new Set([
  "lot_already_published",
  "published_lot_is_immutable",
  "pickup_window_already_ended",
])

export function handleError(error: unknown, response: Response, log: (error: unknown) => void): void {
  if (error instanceof ApplicationError) {
    sendError(response, STATUS_BY_CODE[error.code], error.code, MESSAGE_BY_CODE[error.code])
    return
  }

  if (error instanceof LotRuleError) {
    const conflicting = error.violations.some((violation) => CONFLICT_VIOLATIONS.has(violation))
    sendError(
      response,
      conflicting ? 409 : 422,
      conflicting ? "lot_state_conflict" : "invalid_lot",
      conflicting
        ? "El estado del lote no permite esta operación."
        : "Los datos del lote no cumplen las reglas de publicación.",
      error.violations,
    )
    return
  }

  log(error)
  sendError(response, 500, "internal_error", "No fue posible completar la operación.")
}
