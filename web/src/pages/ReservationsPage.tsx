import './reservations.css'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { formatInstant, formatWindow } from '../lots/lot-time'
import { lotTitle } from '../lots/lot-title'
import { HttpError } from '../services/http-client'
import { cancelReservation, getReservation, listReservations, reservationError,
  type ReservationDetail, type ReservationSummary } from '../services/reservations-service'
import type { ReservationPage } from '../services/openapi'

const labels = { confirmed: 'Confirmada', cancelled: 'Cancelada', expired: 'Vencida', delivered: 'Retirada' } as const
function Facts({ reservation }: { reservation: ReservationSummary }) {
  const { lot } = reservation
  return <><p>{reservation.quantity} {reservation.quantity === 1 ? 'pack' : 'packs'}</p>
    <p>{lot.address}</p><p>{formatWindow(lot.pickupStartsAt, lot.pickupEndsAt, lot.timeZone)} ({lot.timeZone})</p>
    <p>Creada: {formatInstant(reservation.createdAt, lot.timeZone)}</p>
    {reservation.endedAt && <p>Terminada: {formatInstant(reservation.endedAt, lot.timeZone)}</p>}</>
}
function SessionGate({ children }: { children: ReactNode }) {
  const { status, session, error, refreshSession } = useAuth()
  const location = useLocation()
  if (status === 'error') return <Alert tone="danger" role="alert">{error}<Button onClick={() => { void refreshSession() }}>Reintentar sesión</Button></Alert>
  if (status === 'checking' || status === 'signing-out') return <Alert role="status">Comprobando la sesión…</Alert>
  if (!session) return <Alert>Inicia sesión para consultar tus reservas. <Link to={`/login?from=${encodeURIComponent(location.pathname + location.search)}`}>Iniciar sesión</Link></Alert>
  return <div key={session.user.id}>{children}</div>
}
export function ReservationsPage() {
  return <main className="page-content"><div className="reservations"><h1>Mis reservas</h1><p>Reservas vigentes e historial de cancelaciones, retiros y vencimientos.</p><SessionGate><History /></SessionGate></div></main>
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
    {loaded !== query ? <Alert role="status">Cargando reservas…</Alert> : error ? <Alert tone="danger" role="alert">{error}<Button onClick={() => setRetry(v => v + 1)}>Reintentar</Button></Alert> : result && <>
      {result.items.length === 0 && <Card>No hay reservas en esta página. <Link to="/lotes">Explorar lotes</Link></Card>}
      <ul className="reservations__list">{result.items.map(item => <li key={item.id}><Card>
        <Badge tone={item.status === 'confirmed' ? 'success' : 'neutral'}>{labels[item.status]}</Badge>
        <h2><Link to={`/reservas/${encodeURIComponent(item.id)}`}>{lotTitle(item.lot.description)}</Link></h2><Facts reservation={item} />
      </Card></li>)}</ul>
      <nav className="explore-pagination" aria-label="Páginas de reservas">
        {page > 1 && <Button onClick={() => setParams({ pagina: String(page - 1) })}>Página anterior</Button>}
        <span>Página {page}</span>{result.hasNextPage && page < 1000 && <Button onClick={() => setParams({ pagina: String(page + 1) })}>Página siguiente</Button>}
      </nav></>}
  </section>
}
export function ReservationDetailPage() {
  const { id = '' } = useParams()
  return <main className="page-content"><div className="reservations reservation-detail-view"><Link className="back-link" to="/reservas">Volver a mis reservas</Link><h1>Detalle de reserva</h1><SessionGate><Detail key={id} id={id} /></SessionGate></div></main>
}
function Detail({ id }: { id: string }) {
  const { csrfToken, refreshSession } = useAuth()
  const [reservation, setReservation] = useState<ReservationDetail | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [now, setNow] = useState(Date.now)
  const busy = useRef(false)
  const generation = useRef({ value: 0 })
  const resultRef = useRef<HTMLDivElement>(null)
  const load = useCallback(async () => {
    if (busy.current) return
    const version = ++generation.current.value
    setLoading(true); setMessage(null)
    try {
      const value = await getReservation(id)
      if (version !== generation.current.value) return
      setReservation(value); setUncertain(false); if (value.status !== 'confirmed') setConfirming(false); setNow(Date.now())
    } catch (error) {
      if (version !== generation.current.value) return
      setReservation(null); setMessage(reservationError(error))
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
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { active = false; ++requests.value; clearInterval(timer); clearInterval(polling); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [load])
  const cancel = async () => {
    if (busy.current || !csrfToken) return
    busy.current = true; const version = ++generation.current.value; setLoading(false); setCancelling(true); setMessage(null); setUncertain(true)
    try {
      const value = await cancelReservation(id, csrfToken)
      if (version !== generation.current.value) return
      setReservation(value); setUncertain(false); setConfirming(false); setMessage('Cancelación confirmada. Tu reserva permanece en el historial.')
    } catch (error) {
      if (version !== generation.current.value) return
      setMessage(error instanceof HttpError && error.status < 500
        ? reservationError(error)
        : 'No se recibió la confirmación. La cancelación pudo aplicarse. Consulta el estado o reintenta la misma cancelación.')
      if (error instanceof HttpError && error.status === 401) void refreshSession()
    } finally { busy.current = false; if (version === generation.current.value) { setCancelling(false); resultRef.current?.focus() } }
  }
  const closed = reservation ? Date.parse(reservation.lot.pickupEndsAt) <= now : false
  const current = reservation?.status === 'confirmed' && !closed
  return <section className="reservation-detail-content" aria-busy={loading || cancelling}>
    {loading && <Alert role="status">Consultando estado vigente…</Alert>}
    <div className="reservation-result" ref={resultRef} tabIndex={-1}>{message && <Alert tone={reservation?.status === 'cancelled' && !uncertain ? 'success' : 'warning'} role="status">{message}</Alert>}</div>
    {reservation && <Card className="reservation-detail">
      <Badge tone={current && !uncertain ? 'success' : 'neutral'}>{uncertain ? 'Resultado por comprobar' : closed && reservation.status === 'confirmed' ? 'Ventana finalizada' : labels[reservation.status]}</Badge>
      <header className="reservation-detail__heading">
        <h2>{lotTitle(reservation.lot.description)}</h2>
        {reservation.lot.description !== lotTitle(reservation.lot.description) && <p>{reservation.lot.description}</p>}
      </header>
      <dl className="reservation-detail__facts">
        <div><dt>Cantidad reservada</dt><dd>{reservation.quantity} {reservation.quantity === 1 ? 'pack' : 'packs'}</dd></div>
        <div><dt>Lugar de retiro</dt><dd>{reservation.lot.address}</dd></div>
        <div className="reservation-detail__window"><dt>Ventana de retiro</dt><dd>{formatWindow(reservation.lot.pickupStartsAt, reservation.lot.pickupEndsAt, reservation.lot.timeZone)}<span className="reservation-detail__zone">{reservation.lot.timeZone}</span></dd></div>
        <div><dt>Fecha de creación</dt><dd>{formatInstant(reservation.createdAt, reservation.lot.timeZone)}</dd></div>
        {reservation.endedAt && <div><dt>Fecha de término</dt><dd>{formatInstant(reservation.endedAt, reservation.lot.timeZone)}</dd></div>}
      </dl>
      <div className="reservation-detail__conditions"><h3>Condiciones de retiro</h3><p>{reservation.lot.conditions ?? 'Sin condiciones adicionales.'}</p></div>
      {current && !loading && !uncertain && reservation.pickupCode && <div className="pickup-code"><h3>Código de retiro</h3><p>{reservation.pickupCode}</p><span>Muéstralo al operador durante la ventana de retiro.</span></div>}
      {closed && reservation.status === 'confirmed' && <Alert>La ventana terminó. Consulta el estado actualizado; el código ya no se muestra.</Alert>}
      {current && !loading && !uncertain && !confirming && <Button className="reservation-detail__cancel" variant="danger" disabled={!csrfToken} onClick={() => setConfirming(true)}>Cancelar reserva</Button>}
      {(confirming || uncertain) && <Alert className="reservation-cancel" tone="warning"><p>{uncertain ? 'El código se oculta hasta comprobar el resultado.' : '¿Cancelar esta reserva? Los packs quedarán disponibles y el código dejará de servir.'}</p>
        <div className="reservation-cancel__actions">
        <Button className="reservation-cancel__confirm" variant="danger" loading={cancelling} disabled={!csrfToken || loading} onClick={() => { void cancel() }}>{cancelling ? 'Cancelando…' : uncertain ? 'Reintentar cancelación' : 'Confirmar cancelación'}</Button>
        {!uncertain && <Button variant="secondary" onClick={() => setConfirming(false)}>Conservar reserva</Button>}
        </div>
      </Alert>}
    </Card>}
    <Button className="reservation-detail__refresh" variant="secondary" disabled={loading || cancelling} onClick={() => { void load() }}>Consultar estado actualizado</Button>
  </section>
}
