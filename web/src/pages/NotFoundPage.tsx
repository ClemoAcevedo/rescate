import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <main className="page-content">
      <section className="content-card" aria-labelledby="not-found-title">
        <p className="eyebrow">Error 404</p>
        <h1 id="not-found-title">No encontramos esta página</h1>
        <p>La dirección que intentaste visitar no existe o fue movida.</p>
        <Link className="text-link" to="/lotes">
          Ir a Explorar lotes
        </Link>
      </section>
    </main>
  )
}
