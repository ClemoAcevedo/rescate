import { Link, useLocation, useParams } from 'react-router-dom'

export function LotDetailPage() {
  const { id } = useParams()
  const location = useLocation()
  const lotsPath = { pathname: '/lotes', search: location.search }

  return (
    <main className="page-content">
      <section className="content-card" aria-labelledby="lot-detail-title">
        <p className="eyebrow">Lote seleccionado</p>
        <h1 id="lot-detail-title">Detalle del lote</h1>
        <p>
          Estás viendo el lote {id ?? 'sin identificador'}. Próximamente mostrará su
          información disponible.
        </p>
        <Link className="text-link" to={lotsPath}>
          Volver al listado
        </Link>
      </section>
    </main>
  )
}
