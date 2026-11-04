import { Card } from './ui/Card'
import { LoadingState, Skeleton } from './ui/Skeleton'

/** Reservas, solicitudes y listas de operaciones: conserva tarjetas y ritmo vertical. */
export function RecordSkeleton({ label, count = 3, lines = 4 }: { label: string; count?: number; lines?: number }) {
  return <LoadingState label={label}><ul className="record-skeleton">
    {Array.from({ length: count }, (_, index) => <li key={index}><Card>
      <span className="ui-badge"><Skeleton width="6rem" /></span>
      <h2><Skeleton width="75%" /></h2>
      {Array.from({ length: lines }, (_, line) => <p key={line} className={lines === 4 && line === 2 ? 'reservation-facts__window' : undefined}><Skeleton width={line % 2 ? '70%' : '90%'} /></p>)}
    </Card></li>)}
  </ul></LoadingState>
}

export function DetailSkeleton({ label }: { label: string }) {
  return <LoadingState label={label}><Card className="reservation-detail">
    <span className="ui-badge"><Skeleton width="6rem" /></span>
    <header className="reservation-detail__heading"><h2><Skeleton width="75%" /></h2><Skeleton width="60%" /></header>
    <dl className="reservation-detail__facts">{Array.from({ length: 4 }, (_, index) => <div key={index}>
      <dt><Skeleton width="60%" /></dt><dd><Skeleton /></dd>
    </div>)}</dl>
    <div className="reservation-detail__conditions"><Skeleton width="50%" /><Skeleton /></div>
    <Skeleton className="skeleton-code" /><Skeleton className="skeleton-control" width="12rem" />
  </Card></LoadingState>
}
