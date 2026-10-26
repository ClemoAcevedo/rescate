// K035 · Domain: período y tasas del panel del establecimiento (RF10/RF12).
// Reglas puras: reciben la fecha local de hoy; no leen el reloj ni la base.

/** Días que cubre el período por defecto, incluido hoy (informe E1 p. 5: «por período»). */
export const DEFAULT_PERIOD_DAYS = 7
/** Un año como máximo: consultas simples, sin plataforma analítica (anexos A p. 3). */
export const MAX_PERIOD_DAYS = 366

/** Fechas locales `YYYY-MM-DD` del establecimiento, ambas incluidas. */
export interface Period {
  from: string
  to: string
}

export type PeriodRuleViolation = "period_inverted" | "period_too_long"

export class PeriodRuleError extends Error {
  constructor(readonly violation: PeriodRuleViolation) {
    super(`Período inválido: ${violation}`)
    this.name = "PeriodRuleError"
  }
}

const DAY_MS = 86_400_000
const toDays = (date: string): number => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS
const fromDays = (days: number): string => new Date(days * DAY_MS).toISOString().slice(0, 10)

/** Fecha calendario de un instante en la zona del establecimiento. */
export function localDate(at: Date, timeZone: string): string {
  // en-CA formatea como YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
}

/**
 * Sin fechas, los últimos siete días con hoy incluido. Con una sola fecha, `to` es hoy
 * o `from` retrocede seis días. Un período invertido o de más de un año se rechaza.
 */
export function resolvePeriod(requested: Partial<Period>, today: string): Period {
  const to = requested.to ?? today
  const from = requested.from ?? fromDays(toDays(to) - (DEFAULT_PERIOD_DAYS - 1))
  const span = toDays(to) - toDays(from) + 1
  if (span < 1) throw new PeriodRuleError("period_inverted")
  if (span > MAX_PERIOD_DAYS) throw new PeriodRuleError("period_too_long")
  return { from, to }
}

/** Indicador con numerador y denominador explícitos; sin denominador no hay tasa. */
export interface Rate {
  numerator: number
  denominator: number
  value: number | null
}

export function rate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator }
}
