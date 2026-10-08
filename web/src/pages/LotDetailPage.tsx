import './reservations.css'
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
import { UnexpectedResponseError } from '../services/http-client'
import { clearIntent, intentStorageKey, readIntent, saveIntent } from '../services/reservation-intent'
import { lotTitle } from '../lots/lot-title'
import { HttpError, uncertainReservation, discoveryError, getPublicLot, reserveLot,
  type PublicLot, type ReservationResponse } from '../services/discovery-service'

export function LotDetailPage() {
  const { id = '' } = useParams()
  const { session } = useAuth()
  return <LotDetail key={`${id}:${session?.user.id ?? 'visitor'}`} id={id} actor={session?.user.id ?? 'visitor'} />
}

function LotDetail({ id, actor }: { id: string; actor: string }) {
  const location = useLocation()
  const { status, csrfToken, error: sessionError, refreshSession } = useAuth()
  const [lot, setLot] = useState<PublicLot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const storageKey = intentStorageKey(actor, id)
  const [pending] = useState(() => readIntent(storageKey))
  const [quantity, setQuantity] = useState(() => String(pending?.quantity ?? 1))
  const [submitting, setSubmitting] = useState(false)
  const [reservation, setReservation] = useState<ReservationResponse | null>(null)
  const [reserveError, setReserveError] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState(Boolean(pending))
  const key = useRef(pending?.idempotencyKey ?? crypto.randomUUID())
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
    if (busy.current || (!lot && !uncertain) || !csrfToken) return
    const amount = Number(quantity)
    if (!Number.isSafeInteger(amount) || amount < 1 || (!uncertain && amount > (lot?.availableQuantity ?? 0))) {
      setReserveError('Ingresa una cantidad entre 1 y los packs libres indicados.'); return
    }
    busy.current = true; setSubmitting(true); setReserveError(null)
    try {
      try { saveIntent(storageKey, { quantity: amount, idempotencyKey: key.current }) }
      catch { setReserveError('No se pudo conservar la solicitud para reintentar. Habilita el almacenamiento de esta pestaña antes de reservar.'); return }
      const result = await reserveLot(id, { quantity: amount, idempotencyKey: key.current }, csrfToken)
      setReservation(result)
      clearIntent(storageKey)
      setUncertain(false)
      setReload(value => value + 1)
    } catch (error) {
      setReserveError(uncertainReservation(error)
        ? 'No se recibió una respuesta válida. Reintenta con la misma solicitud para comprobar si la reserva se confirmó.'
        : discoveryError(error))
      // Un rechazo de un reintento no resuelve una respuesta perdida anterior.
      setUncertain(uncertain || uncertainReservation(error))
      if (!uncertain && !uncertainReservation(error)) clearIntent(storageKey)
      const responseError = error instanceof UnexpectedResponseError && error.body instanceof HttpError ? error.body : error
      if (responseError instanceof HttpError && responseError.status === 401) await refreshSession()
      if (responseError instanceof HttpError && responseError.status === 409) { setLoading(true); setReload(value => value + 1) }
    } finally { busy.current = false; setSubmitting(false) }
  }
  const changeQuantity = (value: string) => {
    setQuantity(value); setReserveError(null); key.current = crypto.randomUUID()
  }

  return <main className="page-content"><div className="public-lot">
    <Link className="back-link" to={lotsPath}><Icon name="arrowLeft" />Volver a explorar lotes</Link>
    {loading && <Alert className="form-result" role="status">Cargando el lote…</Alert>}
    {loadError && <Alert className="form-result" tone="danger" role="alert">{loadError} <Button variant="secondary" onClick={() => { setLoading(true); setReload(value => value + 1) }}>Reintentar</Button></Alert>}
    {reservation && <div ref={confirmationRef} tabIndex={-1} className="reservation-confirmation reservation-notice">
      <Alert tone="info" role="status">
        <div className="reservation-notice__copy"><h2>Solicitud registrada por {reservation.quantity} {reservation.quantity === 1 ? 'pack' : 'packs'}</h2>
        <p>Consulta el estado vigente, el horario y el código de retiro en el detalle.</p></div>
        <Link className="ui-button ui-button--primary reservation-notice__action" to={`/reservas/${encodeURIComponent(reservation.id)}`}>Ver mi reserva</Link>
        <p className="reservation-confirmation__id">Identificador de reserva: <span>{reservation.id}</span></p>
      </Alert>
    </div>}
    {!lot && uncertain && <Card className="reservation-pending"><Alert tone="warning">Hay una solicitud pendiente de comprobar, aunque el lote ya no esté disponible.</Alert>
      <p>Cantidad solicitada: {quantity} packs.</p>{reserveError && <Alert tone="warning" role="alert">{reserveError}</Alert>}
      {status === 'authenticated' && csrfToken && <form onSubmit={submit}><Button type="submit" loading={submitting}>Comprobar la misma solicitud</Button></form>}
    </Card>}
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
            <h2>Solicitud registrada</h2><p>Solicitaste {reservation.quantity} {reservation.quantity === 1 ? 'pack' : 'packs'} de este lote.</p>
            <Link className="text-link" to={lotsPath}>Seguir explorando</Link>
          </div> : <>
            <div className="reservation-panel__intro"><h2>Solicitar packs</h2><p>Elige cuántos packs vas a retirar. Confirmaremos el stock al reservar.</p></div>
            {lot.availableQuantity === 0 && !uncertain ? <Alert tone="warning">No quedan packs libres. <Link to={lotsPath}>Explora otros lotes</Link>.</Alert>
              : status === 'authenticated' && csrfToken ? <form className="reserve-form" onSubmit={submit}>
                <FormField label="Cantidad de packs" hint={uncertain ? 'Se conserva la cantidad de tu solicitud pendiente.' : `Puedes solicitar entre 1 y ${lot.availableQuantity}.`} required>{control => <div className="reserve-quantity">
                  <Button variant="secondary" aria-label="Quitar un pack" disabled={submitting || uncertain || Number(quantity) <= 1} onClick={() => changeQuantity(String(Math.max(1, Number(quantity) - 1)))}>−</Button>
                  <Input {...control} type="number" min="1" max={uncertain ? undefined : lot.availableQuantity} step="1" disabled={submitting || uncertain} value={quantity} onChange={event => changeQuantity(event.target.value)} />
                  <Button variant="secondary" aria-label="Agregar un pack" disabled={submitting || uncertain || Number(quantity) >= lot.availableQuantity} onClick={() => changeQuantity(String(Math.min(lot.availableQuantity, Number(quantity) + 1)))}>+</Button>
                </div>}</FormField>
                {uncertain && !reserveError && <Alert tone="warning" role="status">Hay una solicitud pendiente de comprobar. Reintenta con la misma cantidad y clave.</Alert>}
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
