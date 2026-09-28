import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { LotPhoto } from '../components/lots/LotPhoto'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/FormControls'
import { FormField } from '../components/ui/FormField'
import { formatInstant } from '../lots/lot-time'
import { ConnectionError, DiscoveryRequestError, UnexpectedResponseError, discoveryError, getPublicLot, reserveLot,
  type PublicLot, type ReservationResponse } from '../services/discovery-service'

export function LotDetailPage() {
  const { id = '' } = useParams()
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
  const lotsPath = { pathname: '/lotes', search: location.search }

  useEffect(() => {
    const controller = new AbortController()
    getPublicLot(id, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setLot(value); setLoadError(null) } })
      .catch(error => { if (!controller.signal.aborted) { setLot(null); setLoadError(discoveryError(error)) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [id, reload])

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
      setLot(current => current ? { ...current, availableQuantity: Math.max(0, current.availableQuantity - result.quantity) } : current)
    } catch (error) {
      setReserveError(error instanceof ConnectionError || error instanceof UnexpectedResponseError
        ? 'No se recibió una respuesta válida. Reintenta con la misma solicitud para comprobar si la reserva se confirmó.'
        : discoveryError(error))
      setUncertain(error instanceof ConnectionError || error instanceof UnexpectedResponseError)
      if (error instanceof DiscoveryRequestError && error.code === 'CONFLICT') { setLoading(true); setReload(value => value + 1) }
    } finally { busy.current = false; setSubmitting(false) }
  }
  const changeQuantity = (value: string) => {
    setQuantity(value); setReserveError(null); setUncertain(false); key.current = crypto.randomUUID()
  }

  return <main className="page-content"><div className="public-lot">
    <Link to={lotsPath}>← Volver a explorar lotes</Link>
    {loading && <Alert className="form-result" role="status">Cargando el lote…</Alert>}
    {loadError && <Alert className="form-result" tone="danger" role="alert">{loadError} <Button variant="secondary" onClick={() => { setLoading(true); setReload(value => value + 1) }}>Reintentar</Button></Alert>}
    {lot && <Card as="article" className="public-lot__card form-result">
      <p className="eyebrow">{lot.category}</p><h1>{lot.description}</h1>
      <LotPhoto src={lot.photoUrl} description={`Fotografía del pack: ${lot.description}`} />
      <Badge tone={lot.availableQuantity > 0 ? 'success' : 'warning'}>{lot.availableQuantity > 0 ? `${lot.availableQuantity} ${lot.availableQuantity === 1 ? 'pack libre' : 'packs libres'}` : 'Sin stock disponible'}</Badge>
      <dl className="public-lot__facts">
        <dt>Contenido</dt><dd>{lot.description}</dd>
        <dt>Pack declarado</dt><dd>{lot.quantity} packs</dd>
        <dt>Lugar de retiro</dt><dd>{lot.address}</dd>
        <dt>Inicio</dt><dd>{formatInstant(lot.pickupStartsAt, lot.timeZone)}</dd>
        <dt>Fin</dt><dd>{formatInstant(lot.pickupEndsAt, lot.timeZone)}</dd>
        {lot.conditions && <><dt>Condiciones</dt><dd>{lot.conditions}</dd></>}
      </dl>
      {reservation ? <Alert tone="success" role="status">Reserva confirmada por {reservation.quantity} {reservation.quantity === 1 ? 'pack' : 'packs'}. Identificador: {reservation.id}.</Alert>
        : lot.availableQuantity === 0 ? <Alert tone="warning">No quedan packs libres. Puedes consultar otros lotes.</Alert>
          : status === 'authenticated' && csrfToken ? <form className="reserve-form" onSubmit={submit}>
            <h2>Solicitar packs</h2><p>La disponibilidad se volverá a comprobar al confirmar.</p>
            <FormField label="Cantidad de packs" required>{control => <Input {...control} type="number" min="1" max={lot.availableQuantity} step="1" value={quantity} onChange={event => changeQuantity(event.target.value)} />}</FormField>
            {reserveError && <Alert tone={uncertain ? 'warning' : 'danger'} role="alert">{reserveError}</Alert>}
            <Button type="submit" loading={submitting}>{submitting ? 'Confirmando…' : uncertain ? 'Comprobar la misma solicitud' : 'Confirmar reserva'}</Button>
          </form> : status === 'anonymous' ? <Alert>Para solicitar packs, <Link to={`/login?from=${encodeURIComponent(location.pathname + location.search)}`}>inicia sesión</Link>. Puedes explorar sin cuenta.</Alert>
            : status === 'error' ? <Alert tone="danger" role="alert">{sessionError ?? 'No se pudo comprobar la sesión.'} <Button variant="secondary" onClick={() => { void refreshSession() }}>Reintentar</Button></Alert>
              : <Alert role="status">Comprobando tu sesión para solicitar packs…</Alert>}
    </Card>}
  </div></main>
}
