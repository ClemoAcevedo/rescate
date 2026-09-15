import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <main className="page-content">
      <section className="content-card" aria-labelledby="not-found-title">
        <p className="eyebrow">Error 404</p>
        <h1 id="not-found-title">Esta página no existe</h1>
        <p>La dirección que intentaste abrir no está disponible en Rescate.</p>
        <Link className="text-link" to="/lotes">
          Ir a Explorar lotes
        </Link>
      </section>
    </main>
  )
}
