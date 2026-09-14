import { Link, useLocation } from 'react-router-dom'
import './Page.css'

export function LotsPage() {
  const { search } = useLocation()

  return (
    <section className="page" aria-labelledby="lots-title">
      <p className="page__eyebrow">Explorar</p>
      <h1 id="lots-title">Explorar lotes</h1>
      <p className="page__description">
        Próximamente encontrarás excedentes de alimentos disponibles para
        aprovechar. Este listado es contenido de demostración.
      </p>
      <Link className="page__link" to={`/lotes/demo${search}`}>
        Ver lote de demostración
      </Link>
    </section>
  )
}
