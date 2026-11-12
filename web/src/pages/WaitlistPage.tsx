import './reservations.css'
import { DetailSkeleton, RecordSkeleton } from '../components/RecordSkeleton'
import { useCallback, useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Icon } from '../components/Icon'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { FormField } from '../components/ui/FormField'
import { Input } from '../components/ui/FormControls'
import { formatInstant, formatWindow } from '../format/date-time'
import { lotTitle } from '../lots/lot-title'
import { HttpError } from '../services/http-client'
import { isUnknownOutcome } from '../services/reservations-service'
import { readIntent, saveIntent, clearIntent } from '../services/reservation-intent'
import { joinWaitlist, getWaitlistEntry, listWaitlist, commandWaitlist, waitlistError, type WaitlistEntry } from '../services/waitlist-service'
import type { WaitlistPage as Page } from '../services/openapi'

const labels = { waiting: 'En espera', offered: 'Oferta por aceptar', accepted: 'Oferta aceptada', declined: 'Oferta rechazada', expired: 'Espera vencida', left: 'Saliste de la lista' }
const tones = { waiting: 'info', offered: 'warning', accepted: 'success', declined: 'neutral', expired: 'neutral', left: 'neutral' } as const
const packs = (n: number) => `${n} ${n === 1 ? 'pack' : 'packs'}`
// Cuenta regresiva m:ss, o h:mm:ss si falta más de una hora.
function countdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}
function Gate({ children }: { children: ReactNode }) {
  const { status, session, error, refreshSession } = useAuth()
  const location = useLocation()
  if (status === 'error') return <Alert role="alert">{error}<Button onClick={() => void refreshSession()}>Reintentar sesión</Button></Alert>
  if (status !== 'authenticated') return status === 'anonymous' ? <Alert>Inicia sesión para gestionar tu espera. <Link to={`/login?from=${encodeURIComponent(location.pathname + location.search)}`}>Iniciar sesión</Link></Alert> : <RecordSkeleton label="Comprobando sesión…" lines={3} />
  return <div key={session?.user.id}>{children}</div>
}
export function JoinWaitlistPage() {
  const { id = '' } = useParams()
  return <main className="page-content"><div className="reservations"><Link className="back-link" to={`/lotes/${encodeURIComponent(id)}`}><Icon name="arrowLeft" />Volver al lote</Link><h1>Unirme a la lista de espera</h1><Gate><Join key={id} lotId={id} /></Gate></div></main>
}
function Join({ lotId }: { lotId: string }) {
  const { session, csrfToken, refreshSession } = useAuth()
  const navigate = useNavigate()
  const storageKey = `rescate:waitlist:${session!.user.id}:${lotId}`
  const [pending] = useState(() => readIntent(storageKey))
  const [quantity, setQuantity] = useState(String(pending?.quantity ?? 1))
  const key = useRef(pending?.idempotencyKey ?? crypto.randomUUID())
  const busy = useRef(false)
  const [sending, setSending] = useState(false)
  const [uncertain, setUncertain] = useState(Boolean(pending))
  const [error, setError] = useState<string | null>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy.current || !csrfToken) return
    const amount = Number(quantity)
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 2147483647) { setError('Ingresa una cantidad entera de packs mayor a cero.'); return }
    busy.current = true; setSending(true); setError(null)
    try {
      try { saveIntent(storageKey, { quantity: amount, idempotencyKey: key.current }) }
      catch { setError('No pudimos guardar tu pedido en esta pestaña. Habilita el almacenamiento del navegador e inténtalo de nuevo.'); return }
      const entry = await joinWaitlist(lotId, { quantity: amount, idempotencyKey: key.current }, csrfToken)
      clearIntent(storageKey)
      navigate(`/espera/${encodeURIComponent(entry.id)}`, { replace: true })
    } catch (reason) {
      const unknown = uncertain || isUnknownOutcome(reason) || (reason instanceof HttpError && reason.status >= 500)
      setUncertain(unknown); setError(waitlistError(reason))
      if (!unknown) { clearIntent(storageKey); key.current = crypto.randomUUID() }
      if (reason instanceof HttpError && reason.status === 401) void refreshSession()
    } finally { busy.current = false; setSending(false) }
  }
  return <Card className="waitlist-join">
    <p>Te avisamos si se liberan packs de este lote. Antes de unirte, ten en cuenta que</p>
    <ul className="waitlist-join__rules">
      <li>Estar en la lista no te reserva packs.</li>
      <li>Puedes recibir una oferta por menos packs de los que pediste.</li>
      <li>Si recibes una oferta, tienes unos minutos para aceptarla. Si no aceptas a tiempo, pierdes tu lugar en la lista.</li>
    </ul>
    <form className="reserve-form" onSubmit={submit}><FormField label="Cantidad de packs" required>{control => <Input {...control} type="number" min="1" max="2147483647" step="1" value={quantity} disabled={sending || uncertain} onChange={e => { setQuantity(e.target.value); key.current = crypto.randomUUID() }} />}</FormField>
      {uncertain && <Alert tone="warning">No pudimos confirmar si quedaste en la lista. Compruébalo antes de intentarlo de nuevo.</Alert>}
      {error && <Alert role="alert" tone="warning">{error}</Alert>}
      <Button type="submit" loading={sending} disabled={!csrfToken}>{uncertain ? 'Comprobar si quedé en la lista' : 'Unirme a la lista de espera'}</Button>
    </form></Card>
}
export function WaitlistPage() {
  return <main className="page-content"><div className="reservations"><h1>Mis esperas</h1><p>Las listas de espera a las que te uniste y sus ofertas.</p><Gate><History /></Gate></div></main>
}
function History() {
  const [params, setParams] = useSearchParams()
  const n = Number(params.get('pagina') ?? 1)
  const page = Number.isSafeInteger(n) && n >= 1 && n <= 1000 ? n : 1
  const [data, setData] = useState<Page | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [loaded, setLoaded] = useState('')
  const query = `${page}:${retry}`
  useEffect(() => {
    const controller = new AbortController()
    listWaitlist(page, controller.signal).then(v => { if (!controller.signal.aborted) { setData(v); setError(null) } }).catch(e => { if (!controller.signal.aborted) { setData(null); setError(waitlistError(e)) } }).finally(() => { if (!controller.signal.aborted) setLoaded(query) })
    return () => controller.abort()
  }, [page, query])
  return <section aria-label="Historial de esperas" aria-busy={loaded !== query}>{loaded !== query ? <RecordSkeleton label="Cargando tus esperas…" lines={3} /> : error ? <Alert role="alert">{error}<Button onClick={() => setRetry(v => v + 1)}>Reintentar</Button></Alert> : data && <>
    {!data.items.length && (page === 1 ? <Card className="empty-state">
      <span className="empty-state__icon"><Icon name="clock" /></span>
      <h2>No estás en ninguna lista de espera</h2>
      <p>Si un lote no tiene packs libres, únete a su lista y te avisamos cuando se liberen.</p>
      <Link className="ui-button ui-button--primary" to="/lotes">Explorar lotes</Link>
    </Card> : <Card className="reservations__end">No hay más esperas. <Button variant="secondary" onClick={() => setParams({})}>Ir a la primera página</Button></Card>)}
    {data.items.length > 0 && <ul className="reservations__list">{data.items.map(entry => <li key={entry.id}><Card><Badge tone={tones[entry.status]}>{labels[entry.status]}</Badge><h2><Link to={`/espera/${encodeURIComponent(entry.id)}`}>{lotTitle(entry.lot.description)}</Link></h2>
      <p>Pediste {packs(entry.requestedQuantity)}</p>
      {entry.status === 'offered' && entry.offeredQuantity !== null && <p>Tienes una oferta por {packs(entry.offeredQuantity)}</p>}
      {entry.position && <p>Tu lugar en la lista: {entry.position}</p>}
    </Card></li>)}</ul>}
    {(page > 1 || data.hasNextPage) && <nav className="explore-pagination" aria-label="Páginas de espera">{page > 1 && <Button onClick={() => setParams({ pagina: String(page - 1) })}>Página anterior</Button>}<span>Página {page}</span>{data.hasNextPage && page < 1000 && <Button onClick={() => setParams({ pagina: String(page + 1) })}>Página siguiente</Button>}</nav>}
  </>}</section>
}
export function WaitlistDetailPage() {
  const { id = '' } = useParams()
  return <main className="page-content"><div className="reservations reservation-detail-view"><Link className="back-link" to="/espera"><Icon name="arrowLeft" />Volver a mis esperas</Link><h1>Tu espera</h1><Gate><Detail key={id} id={id} /></Gate></div></main>
}
function Detail({ id }: { id: string }) {
  const { csrfToken, refreshSession } = useAuth()
  const [entry, setEntry] = useState<WaitlistEntry | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [stale, setStale] = useState(false)
  const [now, setNow] = useState(Date.now)
  const busy = useRef(false)
  const generation = useRef({ value: 0 })
  const load = useCallback(async () => {
    if (busy.current) return
    const version = ++generation.current.value
    setLoading(true)
    try {
      const value = await getWaitlistEntry(id)
      if (version !== generation.current.value) return
      setEntry(value); setUncertain(false); setStale(false); setNow(Date.now()); setMessage(null)
    } catch (e) {
      if (version !== generation.current.value) return
      setStale(true); setMessage(waitlistError(e))
      if (e instanceof HttpError && [401, 403, 404].includes(e.status)) setEntry(null)
      if (e instanceof HttpError && e.status === 401) void refreshSession()
    } finally { if (version === generation.current.value) setLoading(false) }
  }, [id, refreshSession])
  useEffect(() => {
    const requests = generation.current
    let active = true
    void Promise.resolve().then(() => { if (active) void load() })
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    const refresh = () => { if (document.visibilityState === 'visible') void load() }
    const poll = window.setInterval(refresh, 15000)
    window.addEventListener('online', refresh); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh)
    return () => { active = false; ++requests.value; clearInterval(tick); clearInterval(poll); window.removeEventListener('online', refresh); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [load])
  const deadline = entry ? Math.min(Date.parse(entry.lot.pickupEndsAt), entry.offerExpiresAt ? Date.parse(entry.offerExpiresAt) : Infinity) : 0
  const closed = deadline <= now
  const outcomeRef = useRef<HTMLDivElement>(null)
  async function command(action: 'accept' | 'decline' | 'leave') {
    if (busy.current || loading || stale || uncertain || !csrfToken || !entry || Date.now() >= deadline) return
    if (action === 'leave' ? entry.status !== 'waiting' : entry.status !== 'offered') return
    busy.current = true; const version = ++generation.current.value; setSending(true); setMessage(null); setUncertain(true)
    try {
      const result = await commandWaitlist(id, action, csrfToken)
      if (version === generation.current.value) { setEntry(result); setUncertain(false) }
    } catch (e) {
      if (version === generation.current.value) setMessage(`${waitlistError(e)} Actualiza para ver si se aplicó.`)
      if (e instanceof HttpError && e.status === 401) void refreshSession()
    } finally {
      busy.current = false
      if (version === generation.current.value) {
        setSending(false)
        requestAnimationFrame(() => outcomeRef.current?.focus())
      }
    }
  }
  const offered = entry?.status === 'offered' && !closed
  const blocked = loading || sending || stale || uncertain || !csrfToken
  const refresh = <Button className="reservation-detail__refresh" variant="ghost" disabled={loading || sending} onClick={() => void load()}>Actualizar</Button>
  return <section className="reservation-detail-content" aria-busy={loading || sending}>
    {loading && !entry && <DetailSkeleton label="Cargando tu espera…" />}
    {message && <Alert role="alert" tone="warning">{message}</Alert>}
    {entry && <Card className="reservation-detail">
      <div className="reservation-detail__status">
        <div ref={outcomeRef} tabIndex={-1} role="status"><Badge tone={uncertain || stale ? 'warning' : closed && ['waiting', 'offered'].includes(entry.status) ? 'neutral' : tones[entry.status]}>{uncertain ? 'Resultado por comprobar' : stale ? 'Estado sin actualizar' : closed && ['waiting', 'offered'].includes(entry.status) ? 'Plazo finalizado' : labels[entry.status]}</Badge></div>
        {refresh}
      </div>
      <header className="reservation-detail__heading">
        <h2>{lotTitle(entry.lot.description)}</h2>
        {entry.lot.description !== lotTitle(entry.lot.description) && <p>{entry.lot.description}</p>}
      </header>
      {entry.status === 'waiting' && !closed && <div className="waitlist-highlight">
        <p className="waitlist-highlight__lead">Tu lugar en la lista: <strong>{entry.position}</strong></p>
        <p>Te avisaremos en Avisos si se liberan packs para ti.</p>
      </div>}
      {offered && <div className="waitlist-highlight waitlist-highlight--offer">
        <h3>Tienes una oferta por {packs(entry.offeredQuantity!)}</h3>
        <p className="waitlist-highlight__lead">Te quedan <strong>{countdown(deadline - now)}</strong> para aceptar</p>
        <p>Vence el <time dateTime={new Date(deadline).toISOString()}>{formatInstant(new Date(deadline).toISOString(), entry.lot.timeZone)}</time>.</p>
        {entry.offeredQuantity! < entry.requestedQuantity && <p>Te ofrecemos {entry.offeredQuantity} de los {entry.requestedQuantity} packs que pediste. Si aceptas, tu espera termina aquí.</p>}
        <div className="reservation-cancel__actions">
          <Button disabled={blocked} onClick={() => void command('accept')}>Aceptar {packs(entry.offeredQuantity!)}</Button>
          <Button variant="secondary" disabled={blocked} onClick={() => void command('decline')}>Rechazar oferta</Button>
        </div>
      </div>}
      {entry.status === 'accepted' && <Alert tone="success">Aceptaste la oferta y reservaste {packs(entry.offeredQuantity!)}. <Link to={`/reservas/${encodeURIComponent(entry.reservationId!)}`}>Ver mi código de retiro</Link></Alert>}
      {entry.status === 'declined' && <Alert tone="neutral">Rechazaste la oferta y tu espera terminó. <Link to={`/lotes/${encodeURIComponent(entry.lot.id)}`}>Ver el lote</Link></Alert>}
      {entry.status === 'left' && <Alert tone="neutral">Saliste de la lista de espera. <Link to={`/lotes/${encodeURIComponent(entry.lot.id)}`}>Ver el lote</Link></Alert>}
      {(entry.status === 'expired' || (closed && ['waiting', 'offered'].includes(entry.status))) && <Alert tone="neutral">Se acabó el plazo de esta espera y ya no puedes aceptar ofertas. Si aún quieres packs, vuelve a unirte desde el lote. <Link to={`/lotes/${encodeURIComponent(entry.lot.id)}`}>Ver el lote</Link></Alert>}
      <dl className="reservation-detail__facts">
        <div><dt>Packs que pediste</dt><dd>{packs(entry.requestedQuantity)}</dd></div>
        {entry.offeredQuantity !== null && <div><dt>Packs ofrecidos</dt><dd>{packs(entry.offeredQuantity)}</dd></div>}
        <div><dt>Lugar de retiro</dt><dd>{entry.lot.address}</dd></div>
        <div className="reservation-detail__window"><dt>Ventana de retiro</dt><dd>{formatWindow(entry.lot.pickupStartsAt, entry.lot.pickupEndsAt, entry.lot.timeZone)}<span className="reservation-detail__zone">{entry.lot.timeZone}</span></dd></div>
      </dl>
      <div className="reservation-detail__conditions"><h3>Condiciones de retiro</h3><p>{entry.lot.conditions ?? 'Sin condiciones adicionales.'}</p></div>
      <nav className="reservation-detail__links" aria-label="Más opciones de la espera">
        <Link className="ui-button ui-button--secondary" to={`/lotes/${encodeURIComponent(entry.lot.id)}/reportar`} state={{ lotDescription: entry.lot.description }}>Reportar un problema</Link>
      </nav>
      {entry.status === 'waiting' && !closed && <div className="waitlist-leave"><p>Si sales, pierdes tu lugar en la lista.</p><Button variant="danger" disabled={blocked} onClick={() => void command('leave')}>Salir de la lista de espera</Button></div>}
    </Card>}
    {!entry && !loading && refresh}
  </section>
}
