// Reglas puras de intentos fallidos (anexos H p. 21). El login por cuenta y la revisión de
// códigos de retiro por operador comparten cifras: cinco fallos dentro de quince minutos
// bloquean quince minutos. Persistir y serializar los fallos corresponde a Infrastructure.
export const FAILURE_LIMIT = 5
export const FAILURE_WINDOW_MS = 15 * 60 * 1000

/** Límite inclusivo de los fallos que ya salieron de la ventana móvil que termina en `at`. */
export function expiredFailuresCutoff(at: Date): Date {
  return new Date(at.getTime() - FAILURE_WINDOW_MS)
}

/** Bloqueo que deja un fallo nuevo en `at`: quince minutos si completa cinco en la ventana; si no, ninguno. */
export function blockAfterFailure(previous: Date[], at: Date): Date | null {
  const cutoff = expiredFailuresCutoff(at)
  const recent = previous.filter(time => time > cutoff && time <= at).length
  return recent + 1 >= FAILURE_LIMIT ? new Date(at.getTime() + FAILURE_WINDOW_MS) : null
}

/** Segundos que faltan para volver a intentar, redondeados hacia arriba; 0 sin bloqueo vigente. */
export function retryAfterSeconds(blockedUntil: Date | null, at: Date): number {
  return blockedUntil !== null && blockedUntil > at ? Math.ceil((blockedUntil.getTime() - at.getTime()) / 1000) : 0
}
