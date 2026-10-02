// El lote no tiene un campo de título: la web deriva uno corto de la descripción para
// encabezados y tarjetas, y muestra la descripción completa en el detalle.
const MAX_TITLE = 70

export function lotTitle(description: string): string {
  const text = description.trim()
  const [first = ''] = text.split(/:\s|\.\s|\.$|\n/)
  const lead = first.trim()
  if (lead.length >= 8 && lead.length <= MAX_TITLE) return lead
  if (text.length <= MAX_TITLE) return text
  const cut = text.slice(0, MAX_TITLE - 1)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : cut.length).trimEnd()}…`
}
