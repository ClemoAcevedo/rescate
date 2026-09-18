import { Link, useLocation } from 'react-router-dom'

export function LotsPage() {
  const { search } = useLocation()
  const demoLotPath = { pathname: '/lotes/demo', search }

  return (
    <main className="page-content">
      <section className="content-card" aria-labelledby="lots-title">
        <p className="eyebrow">Explorar</p>
        <h1 id="lots-title">Explorar lotes</h1>
        <p>
          Próximamente encontrarás excedentes de alimentos disponibles para aprovechar. Este listado es contenido de demostración.
        </p>
        <Link className="text-link" to={demoLotPath}>
          Ver lote de demostración
        </Link>
      </section>
    </main>
  )
}
