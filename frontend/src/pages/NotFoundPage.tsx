import { Link } from 'react-router-dom'
import './Page.css'

export function NotFoundPage() {
  return (
    <section className="page" aria-labelledby="not-found-title">
      <p className="page__eyebrow">Error 404</p>
      <h1 id="not-found-title">No encontramos esta página</h1>
      <p className="page__description">
        La dirección que intentaste visitar no existe o fue movida.
      </p>
      <Link className="page__link" to="/lotes">
        Ir a Explorar lotes
      </Link>
    </section>
  )
}
