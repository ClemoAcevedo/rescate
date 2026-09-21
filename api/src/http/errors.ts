// HTTP traduce errores semánticos; nunca devuelve diagnósticos internos.
import { IdentityError, PasswordHashingCapacityError } from "../application/identity/errors.js"
import { TrafficLimitError, TrafficCapacityError } from "./rate-limits.js"
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
  if (error instanceof IdentityError) {
    if (error.code === "invalid_input") sendError(response, 422, "VALIDATION_ERROR", "Revisa los campos indicados.", error.fields.map(field => ({
      path: field ? `/${field.replaceAll("~", "~0").replaceAll("/", "~1")}` : "", message: "Campo desconocido, ausente o inválido.",
    })))
    else if (error.code === "email_exists") sendError(response, 409, "CONFLICT", "El correo ya está registrado.")
    else if (error.code === "login_blocked") {
      response.set("Retry-After", String(error.retryAfter))
      sendError(response, 429, "RATE_LIMITED", "Intenta nuevamente después del tiempo indicado.")
    } else sendError(response, 401, "UNAUTHENTICATED", "Credenciales incorrectas o sesión no válida.")
  } else if (error instanceof TrafficLimitError) {
    response.set("Retry-After", String(error.retryAfter))
    sendError(response, 429, "RATE_LIMITED", "Intenta nuevamente después del tiempo indicado.")
  } else if (error instanceof PasswordHashingCapacityError || error instanceof TrafficCapacityError) {
    sendError(response, 503, "SERVICE_UNAVAILABLE", "El servicio no está disponible temporalmente.")
  } else if (error instanceof ApplicationError) {
    const [status, code, message] = errors[error.code]
    sendError(response, status, code, message)
  } else if (error instanceof LotRuleError) {
    if (error.violations.some((violation) => conflicts.has(violation))) {
      sendError(response, 409, "CONFLICT", "El estado del lote no permite esta operación.")
    } else sendError(response, 422, "VALIDATION_ERROR", "Revisa los campos indicados.", error.violations.map((violation) => ({
      path: `/${fields[violation] ?? ""}`, message: "El valor no cumple las reglas del lote.",
    })))
  } else {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""
    log({ event: "request_failed", code: /^[A-Z0-9]{2,20}$/.test(code) ? code : "INTERNAL" })
    const message = error instanceof Error ? error.message : ""
    const connectionTimeout = ["timeout exceeded when trying to connect", "Connection terminated due to connection timeout"].includes(message)
    const unavailable = connectionTimeout || /^(08|53|57P0)/.test(code) || ["55000", "55P03", "57014", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(code)
    sendError(response, unavailable ? 503 : 500, unavailable ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR",
      unavailable ? "El servicio no está disponible temporalmente." : "No fue posible completar la operación.")
  }
}
