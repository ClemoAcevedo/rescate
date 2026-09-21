// HTTP traduce errores semánticos; nunca devuelve diagnósticos internos.
import type { Response } from "express"
import { ApplicationError } from "../application/errors.js"
import { LotRuleError } from "../domain/lots.js"
import type { HttpSchemas } from "./openapi.js"

type ErrorBody = HttpSchemas["ErrorResponse"]
export function sendError(response: Response, status: number, code: ErrorBody["error"]["code"], message: string,
  issues?: HttpSchemas["ValidationIssue"][]): void {
  const body: ErrorBody = { error: { code, message } }
  if (issues?.length) body.error.details = { issues: [issues[0]!, ...issues.slice(1)] }
  response.set("Cache-Control", "no-store").status(status).json(body)
}
const errors = {
  not_authenticated: [401, "UNAUTHENTICATED", "La operación requiere una sesión válida."],
  not_authorized: [403, "FORBIDDEN", "No se permite esta operación."],
  lot_not_found: [404, "NOT_FOUND", "Recurso inexistente."],
  establishment_not_found: [404, "NOT_FOUND", "Recurso inexistente."],
  version_conflict: [409, "CONFLICT", "El lote cambió. Vuelve a consultarlo antes de reintentar."],
} as const
const conflicts = new Set(["lot_already_published", "published_lot_is_immutable"])
const fields: Record<string, string> = {
  description_required: "description", description_too_long: "description", category_required: "category",
  quantity_not_integer: "quantity", quantity_out_of_range: "quantity", address_required: "address",
  latitude_out_of_range: "latitude", longitude_out_of_range: "longitude", time_zone_invalid: "timeZone",
  pickup_window_invalid: "pickupEndsAt", pickup_window_already_ended: "pickupEndsAt",
}
export function handleError(error: unknown, response: Response, log: (error: unknown) => void): void {
  if (error instanceof ApplicationError) {
    const [status, code, message] = errors[error.code]
    sendError(response, status, code, message)
  } else if (error instanceof LotRuleError) {
    if (error.violations.some((violation) => conflicts.has(violation))) {
      sendError(response, 409, "CONFLICT", "El estado del lote no permite esta operación.")
    } else sendError(response, 422, "VALIDATION_ERROR", "Revisa los campos indicados.", error.violations.map((violation) => ({
      path: `/${fields[violation] ?? ""}`, message: "El valor no cumple las reglas del lote.",
    })))
  } else {
    log(error)
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""
    const unavailable = /^(08|53|57P0)/.test(code) || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(code)
    sendError(response, unavailable ? 503 : 500, unavailable ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR",
      unavailable ? "El servicio no está disponible temporalmente." : "No fue posible completar la operación.")
  }
}
