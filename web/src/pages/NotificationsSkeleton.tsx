import { Card } from '../components/ui/Card'
import { LoadingState, Skeleton } from '../components/ui/Skeleton'

export function NotificationsSkeleton({ label = 'Cargando avisos…' }: { label?: string }) {
  return <LoadingState label={label}>
    <p className="notifications__summary"><Skeleton width="14rem" /></p>
    <ul className="notifications__list">{[0, 1, 2].map(index => <li key={index}><Card className="notification">
      <div className="notification__heading"><h2><Skeleton width="16rem" /></h2></div>
      <p className="notification__lot"><Skeleton width="70%" /></p>
      <p><Skeleton /><Skeleton /><Skeleton width="80%" /></p>
      <div className="notification__footer"><time><Skeleton width="10rem" /></time><Skeleton className="skeleton-control notification__action-skeleton" width="8rem" /></div>
    </Card></li>)}</ul>
  </LoadingState>
}
