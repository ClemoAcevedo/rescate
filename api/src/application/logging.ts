// K034 · Registros sin secretos (anexos H pp. 21-22). Un evento lleva solo valores primitivos
// que elige quien registra: nunca el error, la solicitud, cookies, cuerpos, SQL ni códigos
// de retiro. El tipo impide pasar un objeto; Composition elige el sumidero de la API y del worker.
export type LogValue = string | number | boolean | null
export type LogEvent = { event: string } & { [field: string]: LogValue }
export type Log = (event: LogEvent) => void

// Errores de red y archivos que vienen de Node o del sistema operativo, sin datos de quien llama.
const SYSTEM_ERRORS = new Set([
  "EACCES", "EADDRINUSE", "EAI_AGAIN", "EBUSY", "ECANCELED", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET",
  "EEXIST", "EHOSTDOWN", "EHOSTUNREACH", "EISDIR", "EMFILE", "ENETDOWN", "ENETUNREACH", "ENOENT", "ENOSPC",
  "ENOTDIR", "ENOTEMPTY", "ENOTFOUND", "EPERM", "EPIPE", "EPROTO", "EROFS", "ETIMEDOUT",
])

/**
 * Código técnico registrable de un error: un SQLSTATE de PostgreSQL, un error de sistema
 * conocido o un código interno de Node. Cualquier otro valor, incluido uno con la forma de
 * un código de retiro, se registra como INTERNAL.
 */
export function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""
  return /^[0-9A-Z]{5}$/.test(code) || /^ERR_[A-Z0-9_]{1,60}$/.test(code) || SYSTEM_ERRORS.has(code) ? code : "INTERNAL"
}
