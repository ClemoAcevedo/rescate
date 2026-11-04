/** Presentación común: DD/MM/AAAA, HH:mm (00–23), sin depender del navegador. */
export const DEFAULT_TIME_ZONE = 'America/Santiago'

function dateParts(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('es-CL', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(Date.parse(instant))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)!.value
  return { date: `${part('day')}/${part('month')}/${part('year')}`, time: `${part('hour')}:${part('minute')}` }
}

/** Fecha de calendario del contrato, sin convertirla a un instante ni cambiar de día. */
export function formatDate(date: string): string {
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year}`
}

/** El llamador elige explícitamente la zona del lote/establecimiento o la zona común. */
export function formatInstant(instant: string, timeZone: string): string {
  const { date, time } = dateParts(instant, timeZone)
  return `${date} · ${time}`
}

/** Se omite únicamente la segunda fecha cuando ambos extremos caen en el mismo día local. */
export function formatWindow(startsAt: string, endsAt: string, timeZone: string): string {
  const start = dateParts(startsAt, timeZone)
  const end = dateParts(endsAt, timeZone)
  return start.date === end.date
    ? `${start.date} · ${start.time} – ${end.time}`
    : `${start.date} · ${start.time} – ${end.date} · ${end.time}`
}
