import { Card } from '../components/ui/Card'
import { LoadingState, Skeleton } from '../components/ui/Skeleton'

export function CommitmentsSkeleton() {
  return <LoadingState label="Cargando compromisos…"><ul className="panel-commitments">{[0, 1].map(index => <li className="panel-commitment" key={index}>
    <div className="panel-commitment__head"><span className="ui-badge"><Skeleton width="6rem" /></span><span className="panel-commitment__kind"><Skeleton width="5rem" /></span></div>
    <p className="panel-commitment__quantity"><Skeleton width="30%" /></p><p className="panel-commitment__lot"><Skeleton width="80%" /></p><p className="panel-commitment__time"><Skeleton width="70%" /></p>
  </li>)}</ul></LoadingState>
}

export function ActivitySkeleton() {
  return <LoadingState label="Cargando historial…"><ol className="panel-activity">{[0, 1].map(index => <li className="panel-activity__item" key={index}>
    <p><Skeleton width="80%" /></p><p className="panel-activity__meta"><Skeleton /></p>
  </li>)}</ol></LoadingState>
}

export function PanelSkeleton() {
  return <LoadingState label="Cargando el panel…" className="panel-skeleton">
    <section className="panel__section">
      <h2>Ahora</h2>
      <div className="panel-stats">{['Lotes abiertos', 'Reservas por retirar', 'Ofertas por aceptar', 'Personas en espera'].map(label => <Card className="panel-stat" key={label}>
        <p className="panel-stat__label">{label}</p><p className="panel-stat__value"><Skeleton width="3rem" /></p><p className="panel-stat__detail"><Skeleton width="75%" /></p>
      </Card>)}</div>
      <div className="panel-lots">{[0, 1].map(index => <Card className="panel-lot" key={index}>
        <h3><Skeleton width="70%" /></h3><Skeleton /><Skeleton /><Skeleton /><Skeleton className="skeleton-control" />
      </Card>)}</div>
    </section>
    <section className="panel__section"><h2>Resultados del período</h2><Skeleton className="skeleton-control" /><div className="panel-rates">{[0, 1].map(index => <Card className="panel-rate" key={index}><h3><Skeleton width="70%" /></h3><p className="panel-rate__value"><Skeleton width="40%" /></p><Skeleton /></Card>)}</div></section>
    <div className="panel__columns"><section className="panel__section"><h2>Compromisos</h2><CommitmentsSkeleton /></section><section className="panel__section"><h2>Historial</h2><ActivitySkeleton /></section></div>
  </LoadingState>
}
