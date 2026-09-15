import { Link, useLocation } from 'react-router-dom'

export function LotsPage() {
  const location = useLocation()
  const demoLotPath = { pathname: '/lotes/demo', search: location.search }

  return (
    <main className="page-content">
      <section className="content-card" aria-labelledby="lots-title">
        <p className="eyebrow">Disponible próximamente</p>
        <h1 id="lots-title">Explorar lotes</h1>
        <p>
          Aquí podrás descubrir excedentes de alimentos publicados por la comunidad.
        </p>
        <Link className="text-link" to={demoLotPath}>
          Ver lote de demostración
        </Link>
      </section>
    </main>
  )
}
