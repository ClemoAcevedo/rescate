import { Card } from '../ui/Card'
import { LoadingState, Skeleton } from '../ui/Skeleton'

export function LotEditorSkeleton({ label = 'Cargando lote…' }: { label?: string }) {
  return <Card as="section" className="content-card lot-card" aria-busy="true">
    <p className="eyebrow">Operación</p><h1>Lote</h1>
    <LoadingState label={label}>
      <p><Skeleton /></p>
      <div className="lot-form">{Array.from({ length: 6 }, (_, index) => <div className="ui-field" key={index}>
        <span className="ui-field__label"><Skeleton width="35%" /></span><Skeleton className="skeleton-control" />
      </div>)}</div>
    </LoadingState>
  </Card>
}
