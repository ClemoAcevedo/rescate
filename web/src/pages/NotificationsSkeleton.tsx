import { Card } from '../components/ui/Card'
import { LoadingState, Skeleton } from '../components/ui/Skeleton'

export function NotificationsSkeleton({ label = 'Cargando avisos…', incidentsOnly = false }: { label?: string; incidentsOnly?: boolean }) {
  return <LoadingState label={label}>
    <p className="notifications__summary"><Skeleton width="14rem" /></p>
    <ul className="notifications__list">{[0, 1, 2].map(index => <li key={index}><Card className={`notification${incidentsOnly ? ' notification--incident' : ''}`}>
      <div className="notification__heading"><h2><Skeleton width="16rem" /></h2><span className="ui-badge"><Skeleton width="3rem" /></span></div>
      <p className="notification__lot"><Skeleton width="70%" /></p>
      <p><Skeleton /><Skeleton /><Skeleton width="80%" /></p>
      {incidentsOnly && <div className="notification__incident-meta">
        <p><Skeleton width="5rem" /></p><span><Skeleton width="8rem" /></span>
        <p className="notification__reading-note"><Skeleton /><Skeleton width="70%" /></p>
        <p className="notification__read-state"><Skeleton width="16rem" /></p>
      </div>}
      <div className="notification__footer"><time><Skeleton width="10rem" /></time><Skeleton className="skeleton-control notification__action-skeleton" width="8rem" /></div>
    </Card></li>)}</ul>
  </LoadingState>
}
