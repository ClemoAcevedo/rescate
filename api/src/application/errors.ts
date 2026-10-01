// K010 · Application: errores semánticos. No conocen códigos HTTP ni SQL;
// HTTP los traduce según el contrato.

export type ApplicationErrorCode =
  | "not_authenticated"
  | "not_authorized"
  | "lot_not_found"
  | "establishment_not_found"
  | "version_conflict"
  | "idempotency_conflict"
  | "photo_not_found"
  | "photo_upload_expired"
  | "photo_storage_unavailable"
  | "concurrent_photo_uploads"

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode

  constructor(code: ApplicationErrorCode, message: string) {
    super(message)
    this.name = "ApplicationError"
    this.code = code
  }
}

export const notAuthenticated = (): ApplicationError =>
  new ApplicationError("not_authenticated", "La operación requiere una sesión válida.")

export const notAuthorized = (): ApplicationError =>
  new ApplicationError("not_authorized", "El actor no pertenece al establecimiento del lote.")

export const lotNotFound = (): ApplicationError =>
  new ApplicationError("lot_not_found", "El lote no existe.")

export const versionConflict = (): ApplicationError =>
  new ApplicationError("version_conflict", "El lote cambió desde su última lectura.")

export const idempotencyConflict = (): ApplicationError =>
  new ApplicationError("idempotency_conflict", "La reserva no puede confirmarse con el estado actual.")

export const establishmentNotFound = (): ApplicationError =>
  new ApplicationError("establishment_not_found", "El establecimiento no existe.")

export const photoNotFound = (): ApplicationError =>
  new ApplicationError("photo_not_found", "La foto no existe o no está visible.")

export const photoUploadExpired = (): ApplicationError =>
  new ApplicationError("photo_upload_expired", "La carga venció o fue retirada antes de confirmarse.")

export const photoStorageUnavailable = (): ApplicationError =>
  new ApplicationError("photo_storage_unavailable", "El almacenamiento de fotos no está configurado.")

/** E1 I p. 25: máximo dos cargas simultáneas por operador. */
export class ConcurrentUploadsError extends ApplicationError {
  constructor(readonly retryAfter: number) {
    super("concurrent_photo_uploads", "El operador ya tiene el máximo de cargas simultáneas.")
  }
}
