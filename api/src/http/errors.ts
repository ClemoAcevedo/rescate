// HTTP traduce errores semánticos; nunca devuelve diagnósticos internos.
import { IdentityError, PasswordHashingCapacityError } from "../application/identity/errors.js"
import { TrafficLimitError, TrafficCapacityError } from "./rate-limits.js"
import type { Response } from "express"
import { ApplicationError, ConcurrentUploadsError, InventoryDiscrepancyError } from "../application/errors.js"
import { PhotoRuleError } from "../domain/photos.js"
import { LotRuleError } from "../domain/lots.js"
import { ReservationRuleError, ReservationTransitionError } from "../domain/reservations.js"
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
  idempotency_conflict: [409, "CONFLICT", "La clave ya se usó con otros parámetros."],
  photo_not_found: [404, "NOT_FOUND", "Recurso inexistente."],
  photo_upload_expired: [409, "CONFLICT", "La carga venció o el lote cambió; vuelve a cargar la foto."],
  photo_storage_unavailable: [503, "SERVICE_UNAVAILABLE", "El servicio no está disponible temporalmente."],
  concurrent_photo_uploads: [429, "RATE_LIMITED", "Espera a que terminen tus cargas en curso."],
  inventory_discrepancy: [409, "CONFLICT", "El lote está en revisión y no admite reservas por ahora."],
  reservation_not_found: [404, "NOT_FOUND", "Recurso inexistente."],
  pickup_code_not_found: [404, "NOT_FOUND", "El código no corresponde a una reserva de este lote."],
} as const
const transitions = {
  cancelled: "La reserva fue cancelada.",
  expired: "La reserva venció: la ventana de retiro cerró.",
  delivered: "La reserva ya fue retirada.",
  pickup_not_started: "La ventana de retiro aún no comienza.",
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
  } else if (error instanceof ReservationRuleError) {
    if (error.reason === 'invalid_quantity') sendError(response, 422, 'VALIDATION_ERROR', 'Revisa la cantidad.',
      [{ path: '/quantity', message: 'Se requiere un entero entre 1 y 2147483647.' }])
    else sendError(response, 409, 'CONFLICT', error.reason === 'active_commitment'
      ? 'Ya tienes una reserva activa de este lote.' : 'El lote cerró o no tiene packs suficientes.')
  } else if (error instanceof ReservationTransitionError) {
    sendError(response, 409, "CONFLICT", transitions[error.reason])
  } else if (error instanceof PhotoRuleError) {
    if (error.reason === "unrecognized_image") sendError(response, 422, "VALIDATION_ERROR", "El archivo no es una imagen JPEG, PNG o WebP.",
      [{ path: "", message: "Los bytes no corresponden a un formato permitido." }])
    else sendError(response, 409, "CONFLICT", error.reason === "photo_limit_reached"
      ? "El lote ya tiene tres fotos." : "El estado del lote no permite cambiar sus fotos.")
  } else if (error instanceof ApplicationError) {
    if (error instanceof ConcurrentUploadsError) response.set("Retry-After", String(error.retryAfter))
    // El registro es la señal de revisión; el lote sigue bloqueado hasta corregirlo.
    if (error instanceof InventoryDiscrepancyError) log({ event: "inventory_discrepancy", lotId: error.lotId })
    const [status, code, message] = errors[error.code]
    sendError(response, status, code, message)
  } else if (error instanceof LotRuleError) {
    if (error.violations.some((violation) => conflicts.has(violation))) {
      sendError(response, 409, "CONFLICT", "El estado del lote no permite esta operación.")
    } else sendError(response, 422, "VALIDATION_ERROR", "Revisa los campos indicados.", error.violations.map((violation) => (
      violation === "photo_not_ready"
        ? { path: "", message: "Hay fotos en carga, en validación o rechazadas; espera o quítalas antes de publicar." }
        : { path: `/${fields[violation] ?? ""}`, message: "El valor no cumple las reglas del lote." })))
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
