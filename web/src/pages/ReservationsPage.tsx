import './reservations.css'
import { DetailSkeleton, RecordSkeleton } from '../components/RecordSkeleton'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Icon } from '../components/Icon'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Skeleton } from '../components/ui/Skeleton'
import { formatInstant, formatWindow } from '../format/date-time'
import { lotTitle } from '../lots/lot-title'
import { HttpError } from '../services/http-client'
import { cancelReservation, getReservation, listReservations, reservationError,
  type ReservationDetail, type ReservationSummary } from '../services/reservations-service'
import type { ReservationPage } from '../services/openapi'

const labels = { confirmed: 'Confirmada', cancelled: 'Cancelada', expired: 'Vencida', delivered: 'Retirada' } as const
function Facts({ reservation }: { reservation: ReservationSummary }) {
  const { lot } = reservation
  return <><p>{reservation.quantity} {reservation.quantity === 1 ? 'pack' : 'packs'}</p>
    <p>{lot.address}</p><p className="reservation-facts__window">{formatWindow(lot.pickupStartsAt, lot.pickupEndsAt, lot.timeZone)} ({lot.timeZone})</p>
    <p>Creada: {formatInstant(reservation.createdAt, lot.timeZone)}</p>
    {reservation.endedAt && <p>Terminada: {formatInstant(reservation.endedAt, lot.timeZone)}</p>}</>
}
function SessionGate({ children }: { children: ReactNode }) {
  const { status, session, error, refreshSession } = useAuth()
  const location = useLocation()
  if (status === 'error') return <Alert tone="danger" role="alert">{error}<Button onClick={() => { void refreshSession() }}>Reintentar sesión</Button></Alert>
  if (status === 'checking' || status === 'signing-out') return <RecordSkeleton label="Comprobando la sesión…" />
  if (!session) return <Alert>Inicia sesión para consultar tus reservas. <Link to={`/login?from=${encodeURIComponent(location.pathname + location.search)}`}>Iniciar sesión</Link></Alert>
  return <div key={session.user.id}>{children}</div>
}
export function ReservationsPage() {
  return <main className="page-content"><div className="reservations"><h1>Mis reservas</h1><p>Tus reservas vigentes y las que ya terminaron.</p><Link to="/incidencias">Ver historial de incidencias</Link><SessionGate><History /></SessionGate></div></main>
}
function History() {
  const [params, setParams] = useSearchParams()
  const requested = Number(params.get('pagina') ?? 1)
  const page = Number.isSafeInteger(requested) && requested >= 1 && requested <= 1000 ? requested : 1
  const [result, setResult] = useState<ReservationPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const query = `${page}:${retry}`
  const [loaded, setLoaded] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    listReservations(page, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]))
      .then(value => { if (!controller.signal.aborted) { setResult(value); setError(null) } })
      .catch(reason => { if (!controller.signal.aborted) { setResult(null); setError(reservationError(reason)) } })
      .finally(() => { if (!controller.signal.aborted) setLoaded(query) })
    return () => controller.abort()
  }, [page, query])
  return <section aria-label="Historial de reservas" aria-busy={loaded !== query}>
    {loaded !== query ? <RecordSkeleton label="Cargando reservas…" /> : error ? <Alert tone="danger" role="alert">{error}<Button onClick={() => setRetry(v => v + 1)}>Reintentar</Button></Alert> : result && <>
      {result.items.length === 0 && (page === 1 ? <Card className="empty-state">
        <span className="empty-state__icon"><Icon name="box" /></span>
        <h2>Aún no tienes reservas</h2>
        <p>Cuando reserves packs de un lote, aquí verás tu código de retiro y el horario.</p>
        <Link className="ui-button ui-button--primary" to="/lotes">Explorar lotes</Link>
      </Card> : <Card className="reservations__end">No hay más reservas. <Button variant="secondary" onClick={() => setParams({})}>Ir a la primera página</Button></Card>)}
      {result.items.length > 0 && <ul className="reservations__list">{result.items.map(item => <li key={item.id}><Card>
        <Badge tone={item.status === 'confirmed' ? 'success' : 'neutral'}>{labels[item.status]}</Badge>
        <h2><Link to={`/reservas/${encodeURIComponent(item.id)}`}>{lotTitle(item.lot.description)}</Link></h2><Facts reservation={item} />
      </Card></li>)}</ul>}
      {(page > 1 || result.hasNextPage) && <nav className="explore-pagination" aria-label="Páginas de reservas">
        {page > 1 && <Button onClick={() => setParams({ pagina: String(page - 1) })}>Página anterior</Button>}
        <span>Página {page}</span>{result.hasNextPage && page < 1000 && <Button onClick={() => setParams({ pagina: String(page + 1) })}>Página siguiente</Button>}
      </nav>}</>}
  </section>
}
export function ReservationDetailPage() {
  const { id = '' } = useParams()
  return <main className="page-content"><div className="reservations reservation-detail-view"><Link className="back-link" to="/reservas"><Icon name="arrowLeft" />Volver a mis reservas</Link><h1>Detalle de reserva</h1><SessionGate><Detail key={id} id={id} /></SessionGate></div></main>
}
function Detail({ id }: { id: string }) {
  const { csrfToken, refreshSession } = useAuth()
  const [reservation, setReservation] = useState<ReservationDetail | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [stale, setStale] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [now, setNow] = useState(Date.now)
  const busy = useRef(false)
  const generation = useRef({ value: 0 })
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (confirming) confirmRef.current?.focus() }, [confirming])
  const resultRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (message && !cancelling) resultRef.current?.focus() }, [message, cancelling])
  const load = useCallback(async () => {
    if (busy.current) return
    const version = ++generation.current.value
    setLoading(true); setMessage(null)
    try {
      const value = await getReservation(id)
      if (version !== generation.current.value) return
      setReservation(value); setUncertain(false); setStale(false); if (value.status !== 'confirmed') setConfirming(false); setNow(Date.now())
    } catch (error) {
      if (version !== generation.current.value) return
      setStale(true); setMessage(reservationError(error))
      if (error instanceof HttpError && [401, 403, 404].includes(error.status)) setReservation(null)
      if (error instanceof HttpError && error.status === 401) void refreshSession()
    } finally { if (version === generation.current.value) setLoading(false) }
  }, [id, refreshSession])
  useEffect(() => {
    const requests = generation.current
    let active = true
    void Promise.resolve().then(() => { if (active) void load() })
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    const refresh = () => { if (document.visibilityState === 'visible') void load() }
    const polling = window.setInterval(refresh, 15000)
    window.addEventListener('online', refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { active = false; ++requests.value; clearInterval(timer); clearInterval(polling); window.removeEventListener('online', refresh); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [load])
  const cancel = async () => {
    if (busy.current || loading || stale || !csrfToken) return
    busy.current = true; const version = ++generation.current.value; setLoading(false); setCancelling(true); setMessage(null); setUncertain(true)
    try {
      const value = await cancelReservation(id, csrfToken)
      if (version !== generation.current.value) return
      setReservation(value); setUncertain(false); setStale(false); setConfirming(false); setMessage('Cancelaste tu reserva. Seguirá visible en Mis reservas.')
    } catch (error) {
      if (version !== generation.current.value) return
      setMessage(error instanceof HttpError && error.status < 500
        ? reservationError(error)
        : 'No pudimos confirmar si se canceló. Revisa el estado o inténtalo de nuevo.')
      if (error instanceof HttpError && error.status === 401) void refreshSession()
    } finally { busy.current = false; if (version === generation.current.value) { setCancelling(false) } }
  }
  const closed = reservation ? Date.parse(reservation.lot.pickupEndsAt) <= now : false
  const current = reservation?.status === 'confirmed' && !closed
  const refresh = <Button className="reservation-detail__refresh" variant="ghost" disabled={loading || cancelling} onClick={() => { void load() }}>Actualizar</Button>
  return <section className="reservation-detail-content" aria-busy={loading || cancelling}>
    {loading && !reservation && <DetailSkeleton label="Consultando estado vigente…" />}
    <div className="reservation-result" ref={resultRef} tabIndex={-1}>{message && <Alert tone={reservation?.status === 'cancelled' && !uncertain ? 'success' : 'warning'} role="status">{message}</Alert>}</div>
    {reservation && <Card className="reservation-detail">
      <div className="reservation-detail__status">
        <Badge tone={uncertain || stale ? 'warning' : current ? 'success' : 'neutral'}>{uncertain ? 'Resultado por comprobar' : stale ? 'Estado sin actualizar' : closed && reservation.status === 'confirmed' ? 'Ventana finalizada' : labels[reservation.status]}</Badge>
        {refresh}
      </div>
      <header className="reservation-detail__heading">
        <h2>{lotTitle(reservation.lot.description)}</h2>
        {reservation.lot.description !== lotTitle(reservation.lot.description) && <p>{reservation.lot.description}</p>}
      </header>
      {current && !uncertain && reservation.pickupCode && <div className="pickup-code"><h3>Código de retiro</h3><p>{loading ? <Skeleton width="8ch" /> : stale ? 'Oculto' : reservation.pickupCode}</p><span>Muéstralo en el local al retirar.</span></div>}
      {closed && reservation.status === 'confirmed' && <Alert tone="neutral">La ventana de retiro terminó. El código ya no se muestra.</Alert>}
      <dl className="reservation-detail__facts">
        <div><dt>Cantidad reservada</dt><dd>{reservation.quantity} {reservation.quantity === 1 ? 'pack' : 'packs'}</dd></div>
        <div><dt>Lugar de retiro</dt><dd>{reservation.lot.address}</dd></div>
        <div className="reservation-detail__window"><dt>Ventana de retiro</dt><dd>{formatWindow(reservation.lot.pickupStartsAt, reservation.lot.pickupEndsAt, reservation.lot.timeZone)}<span className="reservation-detail__zone">{reservation.lot.timeZone}</span></dd></div>
        <div><dt>Reservada el</dt><dd>{formatInstant(reservation.createdAt, reservation.lot.timeZone)}</dd></div>
        {reservation.endedAt && <div><dt>Terminada el</dt><dd>{formatInstant(reservation.endedAt, reservation.lot.timeZone)}</dd></div>}
      </dl>
      <div className="reservation-detail__conditions"><h3>Condiciones de retiro</h3><p>{reservation.lot.conditions ?? 'Sin condiciones adicionales.'}</p></div>
      <nav className="reservation-detail__links" aria-label="Más opciones de la reserva">
        <Link className="ui-button ui-button--secondary" to={`/reservas/${encodeURIComponent(id)}/chat`} state={{ lotDescription: reservation.lot.description, viewer: 'holder' }}>Chat de la reserva</Link>
        <Link className="ui-button ui-button--secondary" to={`/lotes/${encodeURIComponent(reservation.lot.id)}/reportar`} state={{ lotDescription: reservation.lot.description }}>Reportar un problema</Link>
        <Link className="ui-button ui-button--secondary" to="/incidencias">Historial de incidencias</Link>
      </nav>
      {current && !uncertain && !confirming && <Button ref={cancelRef} className="reservation-detail__cancel" variant="danger" disabled={!csrfToken || loading || stale} onClick={() => setConfirming(true)}>Cancelar reserva</Button>}
      {(confirming || uncertain) && <Alert className="reservation-cancel" tone="warning"><p>{uncertain ? 'Ocultamos el código hasta saber si se canceló.' : '¿Cancelar esta reserva? Los packs quedarán libres para otras personas y tu código dejará de servir.'}</p>
        <div className="reservation-cancel__actions">
        <Button ref={confirmRef} className="reservation-cancel__confirm" variant="danger" loading={cancelling} disabled={!csrfToken || loading || stale} onClick={() => { void cancel() }}>{cancelling ? 'Cancelando…' : uncertain ? 'Reintentar cancelación' : 'Confirmar cancelación'}</Button>
        {!uncertain && <Button variant="secondary" onClick={() => { setConfirming(false); requestAnimationFrame(() => cancelRef.current?.focus()) }}>Conservar reserva</Button>}
        </div>
      </Alert>}
    </Card>}
    {!reservation && !loading && refresh}
  </section>
}
