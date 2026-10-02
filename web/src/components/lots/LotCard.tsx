import { Link, type To } from 'react-router-dom'
import type { PublicLot } from '../../services/discovery-service'
import { formatWindow } from '../../lots/lot-time'
import { lotTitle } from '../../lots/lot-title'
import { Icon } from '../Icon'
import { LotPhoto } from './LotPhoto'

function availabilityLabel(available: number) {
  return available > 0 ? `${available} ${available === 1 ? 'pack libre' : 'packs libres'}` : 'Sin stock'
}

/** Tarjeta de exploración. No es clicable completa: el título es el enlace real al detalle. */
export function LotCard({ lot, to }: { lot: PublicLot; to: To }) {
  const title = lotTitle(lot.description)
  return (
    <article className="lot-card-public ui-card">
      <div className="lot-card-public__media">
        <LotPhoto src={lot.photoUrl} description={`Fotografía del pack: ${title}`} />
        <span className={`lot-card-public__stock${lot.availableQuantity > 0 ? '' : ' lot-card-public__stock--empty'}`}>
          {availabilityLabel(lot.availableQuantity)}
        </span>
      </div>
      <div className="lot-card-public__body">
        <span className="lot-card-public__category">{lot.category}</span>
        <h3><Link to={to}>{title}</Link></h3>
        {title !== lot.description.trim() && <p className="lot-card-public__description">{lot.description}</p>}
        <ul className="lot-meta">
          <li><Icon name="pin" /><span>{lot.address}{lot.distanceKm !== null && <span className="lot-meta__extra"> · a {lot.distanceKm} km</span>}</span></li>
          <li><Icon name="clock" /><time dateTime={lot.pickupStartsAt}>{formatWindow(lot.pickupStartsAt, lot.pickupEndsAt, lot.timeZone)}</time></li>
        </ul>
        <Link className="lot-card-public__link" to={to} aria-hidden="true" tabIndex={-1}>Ver detalle <Icon name="arrowRight" /></Link>
      </div>
    </article>
  )
}
