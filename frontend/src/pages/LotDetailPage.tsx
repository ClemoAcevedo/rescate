import { Link, useLocation, useParams } from 'react-router-dom'
import './Page.css'

export function LotDetailPage() {
  const { id } = useParams()
  const { search } = useLocation()

  return (
    <section className="page" aria-labelledby="lot-detail-title">
      <p className="page__eyebrow">Lote de demostración</p>
      <h1 id="lot-detail-title">Detalle del lote</h1>
      <p className="page__description">
        Estás viendo el lote <strong>{id}</strong>. Los datos reales del lote se
        incorporarán en una etapa posterior.
      </p>
      <Link className="page__link" to={`/lotes${search}`}>
        Volver a Explorar lotes
      </Link>
    </section>
  )
}
