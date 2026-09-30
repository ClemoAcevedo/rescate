// Reglas puras de identidad. Canonicalizar corresponde al port PostgreSQL.
export const SESSION_DURATION_MS = 12 * 60 * 60 * 1000
export const LOGIN_WINDOW_MS = 15 * 60 * 1000
export function validEmail(email: string): boolean {
  // Sintaxis de format: email (OpenAPI); no verifica propiedad del buzón.
  return /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(email)
}
export function validPassword(password: string): boolean {
  return [...password].length >= 12
}
