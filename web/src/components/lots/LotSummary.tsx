import type { LotResponse } from '../../services/lots-service'
import { formatInstant } from '../../lots/lot-time'

/** Vista de solo lectura: un lote publicado no se edita (RF02, OpenAPI). */
export function LotSummary({ lot, establishmentName }: { lot: LotResponse; establishmentName: string }) {
  const rows: Array<[string, string]> = [
    ['Establecimiento', establishmentName],
    ['Descripción del pack', lot.description],
    ['Categoría', lot.category],
    ['Cantidad de packs', String(lot.quantity)],
    ['Condiciones de retiro', lot.conditions ?? 'Sin condiciones particulares'],
    ['Dirección', lot.address],
    ['Coordenadas', `${lot.latitude}, ${lot.longitude}`],
    ['Zona horaria', lot.timeZone],
    ['Inicio del retiro', formatInstant(lot.pickupStartsAt, lot.timeZone)],
    ['Cierre del retiro', formatInstant(lot.pickupEndsAt, lot.timeZone)],
  ]
  if (lot.publishedAt) rows.push(['Publicado', formatInstant(lot.publishedAt, lot.timeZone)])

  return (
    <dl className="lot-summary">
      {rows.map(([term, detail]) => (
        <div key={term} className="lot-summary__row">
          <dt>{term}</dt>
          <dd>{detail}</dd>
        </div>
      ))}
    </dl>
  )
}
