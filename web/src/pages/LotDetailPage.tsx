import { Link, useLocation, useParams } from 'react-router-dom'

export function LotDetailPage() {
  const { id } = useParams()
  const { search } = useLocation()
  const lotsPath = { pathname: '/lotes', search }

  return (
    <main className="page-content">
      <section className="content-card" aria-labelledby="lot-detail-title">
        <p className="eyebrow">Lote de demostración</p>
        <h1 id="lot-detail-title">Detalle del lote</h1>
        <p>
          Estás viendo el lote <strong>{id ?? 'sin identificador'}</strong>. Los datos
          reales del lote se incorporarán en una etapa posterior.
        </p>
        <Link className="text-link" to={lotsPath}>
          Volver a Explorar lotes
        </Link>
      </section>
    </main>
  )
}
