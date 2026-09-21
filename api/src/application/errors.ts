// K010 · Application: errores semánticos. No conocen códigos HTTP ni SQL;
// HTTP los traduce según el contrato.

export type ApplicationErrorCode =
  | "not_authenticated"
  | "not_authorized"
  | "lot_not_found"
  | "establishment_not_found"
  | "version_conflict"

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

export const establishmentNotFound = (): ApplicationError =>
  new ApplicationError("establishment_not_found", "El establecimiento no existe.")
