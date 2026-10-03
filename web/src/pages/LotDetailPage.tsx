import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Icon } from '../components/Icon'
import { LotGallery } from '../components/lots/LotGallery'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/FormControls'
import { FormField } from '../components/ui/FormField'
import { formatInstant } from '../lots/lot-time'
import { lotTitle } from '../lots/lot-title'
import { HttpError, uncertainReservation, discoveryError, getPublicLot, reserveLot,
  type PublicLot, type ReservationResponse } from '../services/discovery-service'

export function LotDetailPage() {
  const { id = '' } = useParams()
  const { session } = useAuth()
  return <LotDetail key={`${id}:${session?.user.id ?? 'visitor'}`} id={id} />
}

function LotDetail({ id }: { id: string }) {
  const location = useLocation()
  const { status, csrfToken, error: sessionError, refreshSession } = useAuth()
  const [lot, setLot] = useState<PublicLot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [quantity, setQuantity] = useState('1')
  const [submitting, setSubmitting] = useState(false)
  const [reservation, setReservation] = useState<ReservationResponse | null>(null)
  const [reserveError, setReserveError] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const key = useRef(crypto.randomUUID())
  const busy = useRef(false)
  const confirmationRef = useRef<HTMLDivElement>(null)
  const lotsPath = { pathname: '/lotes', search: location.search }

  useEffect(() => {
    const controller = new AbortController()
    getPublicLot(id, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setLot(value); setLoadError(null) } })
      .catch(error => { if (!controller.signal.aborted) { setLot(null); setLoadError(discoveryError(error)) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [id, reload])

  useEffect(() => { if (reservation) confirmationRef.current?.focus() }, [reservation])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy.current || !lot || !csrfToken) return
    const amount = Number(quantity)
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > lot.availableQuantity) {
      setReserveError('Ingresa una cantidad entre 1 y los packs libres indicados.'); return
    }
    busy.current = true; setSubmitting(true); setReserveError(null); setUncertain(false)
    try {
      const result = await reserveLot(id, { quantity: amount, idempotencyKey: key.current }, csrfToken)
      setReservation(result)
      setReload(value => value + 1)
    } catch (error) {
      setReserveError(uncertainReservation(error)
        ? 'No se recibió una respuesta válida. Reintenta con la misma solicitud para comprobar si la reserva se confirmó.'
        : discoveryError(error))
      setUncertain(uncertainReservation(error))
      if (error instanceof HttpError && error.status === 401) await refreshSession()
      if (error instanceof HttpError && error.status === 409) { setLoading(true); setReload(value => value + 1) }
    } finally { busy.current = false; setSubmitting(false) }
  }
  const changeQuantity = (value: string) => {
    setQuantity(value); setReserveError(null); setUncertain(false); key.current = crypto.randomUUID()
  }

  return <main className="page-content"><div className="public-lot">
    <Link className="back-link" to={lotsPath}><Icon name="arrowLeft" />Volver a explorar lotes</Link>
    {loading && <Alert className="form-result" role="status">Cargando el lote…</Alert>}
    {loadError && <Alert className="form-result" tone="danger" role="alert">{loadError} <Button variant="secondary" onClick={() => { setLoading(true); setReload(value => value + 1) }}>Reintentar</Button></Alert>}
    {reservation && <div ref={confirmationRef} tabIndex={-1} className="reservation-confirmation">
      <Alert tone="success" role="status">
        <h2>Reserva confirmada por {reservation.quantity} {reservation.quantity === 1 ? 'pack' : 'packs'}</h2>
        <p>Revisa el lugar, el horario y las condiciones de retiro.</p>
        <p className="reservation-confirmation__id">Identificador de reserva: <span>{reservation.id}</span></p>
      </Alert>
    </div>}
    {lot && <>
      <header className="public-lot__header">
        <Badge tone="success">{lot.category}</Badge>
        <h1>{lotTitle(lot.description)}</h1>
        <p className="public-lot__address"><Icon name="pin" />{lot.address}{lot.distanceKm !== null && ` · a ${lot.distanceKm} km`}</p>
      </header>
      <div className="public-lot__layout">
        <LotGallery photos={lot.photos} title={lotTitle(lot.description)} />
        <article className="public-lot__information" aria-label="Información del lote">
          <section className="public-lot__section" aria-labelledby="contents-heading">
            <h2 id="contents-heading">Qué incluye</h2>
            <p className="public-lot__description">{lot.description}</p>
            <p className="public-lot__hint"><Icon name="box" />{lot.quantity} {lot.quantity === 1 ? 'pack publicado' : 'packs publicados'} en este lote.</p>
          </section>
          <section className="public-lot__section" aria-labelledby="pickup-heading">
            <h2 id="pickup-heading">Tu retiro</h2>
            <dl className="public-lot__facts">
              <div><dt><Icon name="pin" />Lugar de retiro</dt><dd>{lot.address}</dd></div>
              <div><dt><Icon name="clock" />Desde</dt><dd><time dateTime={lot.pickupStartsAt}>{formatInstant(lot.pickupStartsAt, lot.timeZone)}</time></dd></div>
              <div><dt><Icon name="clock" />Hasta</dt><dd><time dateTime={lot.pickupEndsAt}>{formatInstant(lot.pickupEndsAt, lot.timeZone)}</time></dd></div>
            </dl>
            <p className="public-lot__hint">Horario del lugar de retiro ({lot.timeZone}).</p>
          </section>
          <section className="public-lot__section" aria-labelledby="conditions-heading">
            <h2 id="conditions-heading">Condiciones del lote</h2>
            <p className="public-lot__conditions">{lot.conditions || 'Este lote no tiene condiciones adicionales indicadas.'}</p>
          </section>
        </article>
        <Card as="section" className="reservation-panel" aria-label="Reserva de packs">
          <Badge tone={lot.availableQuantity > 0 ? 'success' : 'warning'}>{lot.availableQuantity > 0 ? `${lot.availableQuantity} ${lot.availableQuantity === 1 ? 'pack libre' : 'packs libres'}` : 'Sin stock disponible'}</Badge>
          {reservation ? <div className="reservation-panel__intro">
            <h2>Tu reserva está lista</h2><p>Reservaste {reservation.quantity} {reservation.quantity === 1 ? 'pack' : 'packs'} de este lote.</p>
            <Link className="text-link" to={lotsPath}>Seguir explorando</Link>
          </div> : <>
            <div className="reservation-panel__intro"><h2>Solicitar packs</h2><p>Elige cuántos packs vas a retirar. Confirmaremos el stock al reservar.</p></div>
            {lot.availableQuantity === 0 ? <Alert tone="warning">No quedan packs libres. <Link to={lotsPath}>Explora otros lotes</Link>.</Alert>
              : status === 'authenticated' && csrfToken ? <form className="reserve-form" onSubmit={submit}>
                <FormField label="Cantidad de packs" hint={`Puedes solicitar entre 1 y ${lot.availableQuantity}.`} required>{control => <div className="reserve-quantity">
                  <Button variant="secondary" aria-label="Quitar un pack" disabled={submitting || uncertain || Number(quantity) <= 1} onClick={() => changeQuantity(String(Math.max(1, Number(quantity) - 1)))}>−</Button>
                  <Input {...control} type="number" min="1" max={lot.availableQuantity} step="1" disabled={submitting || uncertain} value={quantity} onChange={event => changeQuantity(event.target.value)} />
                  <Button variant="secondary" aria-label="Agregar un pack" disabled={submitting || uncertain || Number(quantity) >= lot.availableQuantity} onClick={() => changeQuantity(String(Math.min(lot.availableQuantity, Number(quantity) + 1)))}>+</Button>
                </div>}</FormField>
                {reserveError && <Alert tone={uncertain ? 'warning' : 'danger'} role="alert">{reserveError}</Alert>}
                <Button type="submit" block loading={submitting}>{submitting ? 'Confirmando…' : uncertain ? 'Comprobar la misma solicitud' : 'Confirmar reserva'}</Button>
                <p className="public-lot__hint">La reserva se confirma cuando recibes su identificador.</p>
              </form> : status === 'anonymous' ? <div className="reservation-panel__login">
                <p>Para solicitar packs, inicia sesión con tu cuenta. Volverás a este lote.</p>
                <Link className="ui-button ui-button--primary ui-button--block" to={`/login?from=${encodeURIComponent(location.pathname + location.search)}`}>Inicia sesión para reservar</Link>
              </div> : status === 'error' ? <Alert tone="danger" role="alert">{sessionError ?? 'No se pudo comprobar la sesión.'} <Button variant="secondary" onClick={() => { void refreshSession() }}>Reintentar</Button></Alert>
                : <Alert role="status">Comprobando tu sesión para solicitar packs…</Alert>}
          </>}
        </Card>
      </div>
    </>}
  </div></main>
}
