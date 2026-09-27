// La ventana de retiro se escribe como hora local del lugar del lote (su zona IANA),
// no del navegador. OpenAPI exige RFC 3339 con offset explícito; el servidor responde en UTC.

const localPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export function supportedTimeZones(): string[] {
  return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
}

/** Zona por defecto de un lote nuevo: la del lugar de retiro, no la del navegador del operador. */
export const DEFAULT_TIME_ZONE = 'America/Santiago'

function wallClock(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute') }
}

/** Offset de la zona en ese instante, en minutos (ej. -180 para UTC-03:00). */
function offsetMinutes(instant: number, timeZone: string): number {
  const wall = wallClock(instant, timeZone)
  const asUtc = Date.UTC(Number(wall.year), Number(wall.month) - 1, Number(wall.day), Number(wall.hour), Number(wall.minute))
  return Math.round((asUtc - Math.floor(instant / 60000) * 60000) / 60000)
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}

/** Valor `YYYY-MM-DDTHH:mm` de un input datetime-local para el instante en la zona dada. */
export function instantToLocalInput(instant: string, timeZone: string): string {
  const wall = wallClock(Date.parse(instant), timeZone)
  return `${wall.year}-${wall.month}-${wall.day}T${wall.hour}:${wall.minute}`
}

/**
 * Convierte la hora local del lote a RFC 3339 con offset. Devuelve null si el texto no es
 * una hora local válida o si no existe en esa zona (salto por cambio de horario).
 */
export function localInputToInstant(local: string, timeZone: string): string | null {
  const match = localPattern.exec(local)
  if (!match || !isValidTimeZone(timeZone)) return null
  const [, year, month, day, hour, minute] = match
  const guess = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))
  let instant = guess - offsetMinutes(guess, timeZone) * 60000
  const corrected = guess - offsetMinutes(instant, timeZone) * 60000
  if (corrected !== instant) instant = corrected
  if (instantToLocalInput(new Date(instant).toISOString(), timeZone) !== local) return null
  return `${local}:00${formatOffset(offsetMinutes(instant, timeZone))}`
}

export function formatInstant(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(Date.parse(instant))
}
