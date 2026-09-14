import { RescateLogo } from '../components/RescateLogo'
import './HomePage.css'

export function HomePage() {
  return (
    <main className="home-page">
      <section className="home-page__content" aria-labelledby="home-title">
        <RescateLogo className="home-page__brand" />
        <p className="home-page__eyebrow">Aprovechamiento de alimentos</p>
        <h1 id="home-title">Conectamos excedentes con nuevas oportunidades.</h1>
        <p className="home-page__description">
          Rescate es una plataforma para publicar y encontrar alimentos que aún
          pueden aprovecharse.
        </p>
        <p className="home-page__notice">
          Próximamente podrás explorar lotes y sumarte a esta red.
        </p>
      </section>
    </main>
  )
}
