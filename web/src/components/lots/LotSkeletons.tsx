import { Icon } from '../Icon'
import { Card } from '../ui/Card'
import { LoadingState, Skeleton } from '../ui/Skeleton'

export function LotsSkeleton() {
  return <LoadingState label="Buscando lotes…">
    <p className="explore-results__order"><Skeleton width="20rem" /></p>
    <div className="explore-list">{Array.from({ length: 3 }, (_, index) => <article className="lot-card-public ui-card" key={index}>
      <div className="lot-card-public__media"><Skeleton className="lot-photo" /></div>
      <div className="lot-card-public__body">
        <span className="lot-card-public__category"><Skeleton width="35%" /></span>
        <h3><Skeleton width="85%" /><Skeleton width="60%" /></h3>
        <p className="lot-card-public__description"><Skeleton /><Skeleton width="70%" /></p>
        <ul className="lot-meta">
          <li><Icon name="pin" /><span><Skeleton /><Skeleton width="60%" /></span></li>
          <li><Icon name="clock" /><span><Skeleton /><Skeleton width="70%" /></span></li>
        </ul>
        <span className="lot-card-public__link"><Skeleton width="6rem" /></span>
      </div>
    </article>)}</div>
  </LoadingState>
}

export function LotDetailSkeleton() {
  return <LoadingState label="Cargando el lote…">
    <header className="public-lot__header">
      <span className="ui-badge"><Skeleton width="6rem" /></span>
      <h1><Skeleton width="18rem" /></h1>
      <p className="public-lot__address"><Skeleton width="15rem" /></p>
    </header>
    <div className="public-lot__layout">
      <div className="lot-gallery"><Skeleton className="lot-photo" /></div>
      <article className="public-lot__information">
        {['Qué incluye', 'Tu retiro', 'Condiciones del lote'].map(title => <section className="public-lot__section" key={title}>
          <h2>{title}</h2><p><Skeleton /><Skeleton width="75%" /></p>
        </section>)}
      </article>
      <Card className="reservation-panel">
        <div className="reservation-panel__waitlist"><Skeleton /><Skeleton /><Skeleton /></div>
        <span className="ui-badge"><Skeleton width="7rem" /></span>
        <div className="reservation-panel__intro"><h2>Solicitar packs</h2><p><Skeleton /><Skeleton /></p></div>
        <div className="reserve-form"><Skeleton className="skeleton-control" /><Skeleton className="skeleton-control" /></div>
      </Card>
    </div>
  </LoadingState>
}

export function MyLotsSkeleton() {
  return <LoadingState label="Cargando tus lotes…"><ul className="my-lots__list">
    {Array.from({ length: 3 }, (_, index) => <li className="my-lot" key={index}>
      <div className="my-lot__media"><Skeleton className="lot-photo" /></div>
      <div className="my-lot__body">
        <div className="my-lot__labels"><span className="ui-badge"><Skeleton>Publicado</Skeleton></span><span className="my-lot__category"><Skeleton>Panadería</Skeleton></span></div>
        <h2><Skeleton /><Skeleton width="70%" /></h2>
        <ul className="lot-meta"><li><Icon name="clock" /><span><Skeleton /><Skeleton width="75%" /></span></li><li><Icon name="box" /><span><Skeleton /><Skeleton width="75%" /></span></li></ul>
      </div>
      <div className="my-lot__actions">{['Ver lote', 'Validar retiros', 'Vista pública'].map((label, index) => <span className="ui-button ui-button--secondary" key={label}>
        {index === 2 && <Icon name="eye" />}<Skeleton>{label}</Skeleton>
      </span>)}</div>
    </li>)}
  </ul></LoadingState>
}
