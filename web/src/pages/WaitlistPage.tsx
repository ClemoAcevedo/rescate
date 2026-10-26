import './reservations.css'
import { useCallback, useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { FormField } from '../components/ui/FormField'
import { Input } from '../components/ui/FormControls'
import { formatInstant, formatWindow } from '../lots/lot-time'
import { lotTitle } from '../lots/lot-title'
import { HttpError } from '../services/http-client'
import { isUnknownOutcome } from '../services/reservations-service'
import { readIntent, saveIntent, clearIntent } from '../services/reservation-intent'
import { joinWaitlist, getWaitlistEntry, listWaitlist, commandWaitlist, waitlistError, type WaitlistEntry } from '../services/waitlist-service'
import type { WaitlistPage as Page } from '../services/openapi'

const labels = { waiting: 'En espera', offered: 'Oferta pendiente de aceptación', accepted: 'Oferta aceptada', declined: 'Oferta rechazada', expired: 'Solicitud vencida', left: 'Fuera de la cola' }
function Gate({ children }: { children: ReactNode }) {
  const { status, session, error, refreshSession } = useAuth()
  const location = useLocation()
  if (status === 'error') return <Alert role="alert">{error}<Button onClick={() => void refreshSession()}>Reintentar sesión</Button></Alert>
  if (status !== 'authenticated') return status === 'anonymous' ? <Alert>Inicia sesión para gestionar tu espera. <Link to={`/login?from=${encodeURIComponent(location.pathname + location.search)}`}>Iniciar sesión</Link></Alert> : <Alert role="status">Comprobando sesión…</Alert>
  return <div key={session?.user.id}>{children}</div>
}
export function JoinWaitlistPage() {
  const { id = '' } = useParams()
  return <main className="page-content"><div className="reservations"><Link to={`/lotes/${encodeURIComponent(id)}`}>Volver al lote</Link><h1>Entrar a la espera</h1><Gate><Join key={id} lotId={id} /></Gate></div></main>
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
      catch { setError('Habilita el almacenamiento de esta pestaña para conservar la solicitud antes de enviarla.'); return }
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
  return <Card><p>Entrar es voluntario y no crea una reserva ni retiene packs mientras esperas. Solo corresponde si no puedes reservar directamente o hay personas esperando.</p>
    <p>Podrías recibir menos packs que los solicitados. Deberás aceptar la oferta expresamente antes de su vencimiento. Aceptar, rechazar o dejarla vencer cierra la solicitud sin saldo ni prioridad residual; no hay reingreso automático.</p>
    <form className="reserve-form" onSubmit={submit}><FormField label="Cantidad solicitada" required>{control => <Input {...control} type="number" min="1" max="2147483647" step="1" value={quantity} disabled={sending || uncertain} onChange={e => { setQuantity(e.target.value); key.current = crypto.randomUUID() }} />}</FormField>
      {uncertain && <Alert tone="warning">Hay un ingreso pendiente de comprobar. El reintento conserva la misma cantidad y clave.</Alert>}
      {error && <Alert role="alert" tone="warning">{error}</Alert>}
      <Button type="submit" loading={sending} disabled={!csrfToken}>{uncertain ? 'Comprobar el mismo ingreso' : 'Entrar voluntariamente a la espera'}</Button>
      <Link to="/espera">Ver mis solicitudes</Link><Link to="/reservas">Ver mis reservas</Link>
    </form></Card>
}
export function WaitlistPage() {
  return <main className="page-content"><div className="reservations"><h1>Mis solicitudes de espera</h1><p>Estar en espera o recibir una oferta requiere aceptación explícita para crear una reserva.</p><Gate><History /></Gate></div></main>
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
  return <section>{loaded !== query ? <Alert role="status">Consultando solicitudes…</Alert> : error ? <Alert role="alert">{error}<Button onClick={() => setRetry(v => v + 1)}>Reintentar</Button></Alert> : data && <>
    {!data.items.length && <p>No hay solicitudes en esta página. <Link to="/lotes">Explorar lotes</Link></p>}
    <ul className="reservations__list">{data.items.map(entry => <li key={entry.id}><Card><Badge>{labels[entry.status]}</Badge><h2><Link to={`/espera/${encodeURIComponent(entry.id)}`}>{lotTitle(entry.lot.description)}</Link></h2><p>{entry.requestedQuantity} packs solicitados</p>{entry.position && <p>Tu posición en la cola: {entry.position}</p>}<p>Consulta el detalle para comprobar el estado vigente.</p></Card></li>)}</ul>
    <nav className="explore-pagination" aria-label="Páginas de espera">{page > 1 && <Button onClick={() => setParams({ pagina: String(page - 1) })}>Página anterior</Button>}<span>Página {page}</span>{data.hasNextPage && page < 1000 && <Button onClick={() => setParams({ pagina: String(page + 1) })}>Página siguiente</Button>}</nav>
  </>}</section>
}
export function WaitlistDetailPage() {
  const { id = '' } = useParams()
  return <main className="page-content"><div className="reservations"><Link to="/espera">Volver a mis solicitudes</Link><h1>Estado de mi solicitud</h1><Gate><Detail key={id} id={id} /></Gate></div></main>
}
function Detail({ id }: { id: string }) {
  const { csrfToken, refreshSession } = useAuth()
  const [entry, setEntry] = useState<WaitlistEntry | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [uncertain, setUncertain] = useState(false)
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
      setEntry(value); setUncertain(false); setNow(Date.now()); setMessage(null)
    } catch (e) {
      if (version !== generation.current.value) return
      setEntry(null); setMessage(waitlistError(e))
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
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh)
    return () => { active = false; ++requests.value; clearInterval(tick); clearInterval(poll); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [load])
  const deadline = entry ? Math.min(Date.parse(entry.lot.pickupEndsAt), entry.offerExpiresAt ? Date.parse(entry.offerExpiresAt) : Infinity) : 0
  const closed = deadline <= now
  const outcomeRef = useRef<HTMLDivElement>(null)
  async function command(action: 'accept' | 'decline' | 'leave') {
    if (busy.current || loading || uncertain || !csrfToken || !entry || Date.now() >= deadline) return
    if (action === 'leave' ? entry.status !== 'waiting' : entry.status !== 'offered') return
    busy.current = true; const version = ++generation.current.value; setSending(true); setMessage(null); setUncertain(true)
    try {
      const result = await commandWaitlist(id, action, csrfToken)
      if (version === generation.current.value) { setEntry(result); setUncertain(false) }
    } catch (e) {
      if (version === generation.current.value) setMessage(`${waitlistError(e)} La acción pudo haberse aplicado; comprueba el resultado.`)
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
  return <section className="reservation-detail-content" aria-busy={loading || sending}>
    {loading && <Alert role="status">Consultando estado vigente…</Alert>}
    {message && <Alert role="alert" tone="warning">{message}</Alert>}
    {entry && <Card className="reservation-detail"><div ref={outcomeRef} tabIndex={-1} role="status"><Badge tone={offered ? 'warning' : 'neutral'}>{uncertain ? 'Resultado por comprobar' : closed && ['waiting', 'offered'].includes(entry.status) ? 'Plazo finalizado' : labels[entry.status]}</Badge></div>
      <h2>{lotTitle(entry.lot.description)}</h2><p>{entry.lot.description}</p>
      <dl className="reservation-detail__facts"><div><dt>Cantidad solicitada</dt><dd>{entry.requestedQuantity} packs</dd></div>{entry.offeredQuantity !== null && <div><dt>Cantidad ofrecida</dt><dd>{entry.offeredQuantity} packs</dd></div>}<div><dt>Lugar de retiro</dt><dd>{entry.lot.address}</dd></div><div><dt>Ventana de retiro</dt><dd>{formatWindow(entry.lot.pickupStartsAt, entry.lot.pickupEndsAt, entry.lot.timeZone)} ({entry.lot.timeZone})</dd></div></dl>
      <p>{entry.lot.conditions ?? 'Sin condiciones adicionales.'}</p>
      {entry.status === 'waiting' && !closed && <><p>Tu posición en la cola: {entry.position}. Esperar no retiene packs ni crea una reserva.</p><Button variant="danger" disabled={loading || sending || uncertain || !csrfToken} onClick={() => void command('leave')}>Salir de la espera y perder mi posición</Button></>}
      {offered && <><Alert tone="warning">Tienes una oferta por {entry.offeredQuantity} de los {entry.requestedQuantity} packs solicitados. Aún no tienes una reserva. Al aceptar se cierra la solicitud sin saldo ni prioridad por los packs restantes.</Alert>
        <p>Vence: {formatInstant(entry.offerExpiresAt!, entry.lot.timeZone)}. Tiempo orientativo: {Math.max(0, Math.ceil((deadline - now) / 1000))} s. El servidor comprueba la vigencia al aceptar.</p>
        <div className="reservation-cancel__actions"><Button disabled={loading || sending || uncertain || !csrfToken} onClick={() => void command('accept')}>Aceptar explícitamente {entry.offeredQuantity} packs</Button><Button variant="danger" disabled={loading || sending || uncertain || !csrfToken} onClick={() => void command('decline')}>Rechazar oferta y salir de la cola</Button></div></>}
      {entry.status === 'accepted' && <Alert tone="success">La oferta fue aceptada por {entry.offeredQuantity} packs y la solicitud se cerró. <Link to={`/reservas/${encodeURIComponent(entry.reservationId!)}`}>Consultar mi reserva y código de retiro</Link></Alert>}
      {(entry.status === 'expired' || entry.status === 'declined' || entry.status === 'left' || (closed && ['waiting', 'offered'].includes(entry.status))) && <Alert>Esta solicitud terminó o su plazo finalizó. No puedes aceptar una oferta vencida. No conserva posición ni reingresa automáticamente. <Link to={`/lotes/${encodeURIComponent(entry.lot.id)}`}>Volver al lote para una nueva solicitud voluntaria</Link></Alert>}
    </Card>}
    {uncertain && <Alert tone="warning">Comprueba el estado para saber si la acción se aplicó. No se anuncia una reserva hasta recibir la aceptación confirmada.</Alert>}
    <Button variant="secondary" disabled={loading || sending} onClick={() => void load()}>Consultar estado actualizado</Button>
  </section>
}
