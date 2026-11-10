import { useCallback, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { LoadingState, Skeleton } from '../components/ui/Skeleton'
import { DEFAULT_TIME_ZONE, formatInstant } from '../format/date-time'
import { NOTIFICATION_POLL_MS, useVisiblePolling } from '../notifications/use-visible-polling'
import { setUnreadCount } from '../notifications/unread'
import { getNotification, listNotifications, markNotificationRead, notificationError, type Notification } from '../services/notifications-service'
import './notifications.css'

const states = { open: 'Abierta', following: 'En seguimiento', resolved: 'Resuelta' }

function IncidentSkeleton() {
  return <LoadingState label="Cargando incidencia…"><Card className="incident-detail">
    <div className="incident-detail__meta"><span className="ui-badge"><Skeleton width="4rem" /></span><span><Skeleton width="5rem" /></span><time><Skeleton width="10rem" /></time></div>
    <h2><Skeleton width="70%" /></h2>
    <div className="incident-detail__context">
      <p className="incident-detail__delivery"><Skeleton /><Skeleton /></p>
      <p className="incident-detail__closure"><Skeleton /><Skeleton /></p>
    </div>
    <section className="incident-detail__text"><h3>Motivo</h3><p><Skeleton /><Skeleton /></p></section>
    <section className="incident-detail__text"><h3>Instrucciones</h3><p><Skeleton /><Skeleton /></p></section>
    <div className="incident-detail__read">
      <p><Skeleton width="16rem" /></p><Skeleton className="skeleton-control incident-detail__action" />
      <p className="incident-detail__disclaimer"><Skeleton /><Skeleton width="70%" /></p>
    </div>
  </Card></LoadingState>
}

function Notice({ id, csrfToken }: { id: string; csrfToken: string }) {
  const [notice, setNotice] = useState<Notification | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const busy = useRef(false)
  const load = useCallback(() => {
    if (busy.current) return
    busy.current = true; setRefreshing(true)
    getNotification(id).then(value => {
      if (value.kind !== 'incident_version' || !value.incident) throw new Error('Aviso sin incidencia.')
      setNotice(value); setError(null)
    }).catch(reason => setError(notificationError(reason))).finally(() => { busy.current = false; setRefreshing(false) })
  }, [id])
  useVisiblePolling(load, NOTIFICATION_POLL_MS)

  const read = async () => {
    if (busy.current || !notice) return
    busy.current = true; setReading(true); setError(null)
    try {
      const result = await markNotificationRead(id, csrfToken)
      setNotice(result)
      // El contador viene del servidor para conservar lecturas concurrentes en otras pestañas.
      void listNotifications(1).then(page => setUnreadCount(page.unreadCount)).catch(() => {})
    } catch {
      setError('No se pudo confirmar el registro de lectura. Reintenta; se conserva la primera lectura si ya se registró.')
    } finally { busy.current = false; setReading(false) }
  }
  if (!notice?.incident) return error
    ? <Alert tone="danger" role="alert"><p>{error}</p><Button onClick={load} loading={refreshing}>Reintentar</Button></Alert>
    : <IncidentSkeleton />
  const incident = notice.incident
  return <section aria-label="Detalle de incidencia" aria-busy={reading || refreshing}>
    <span className="visually-hidden" role="status">{refreshing ? 'Actualizando incidencia…' : ''}</span>
    {error && <Alert tone="warning" role="status">{error}<Button variant="secondary" onClick={load}>Reintentar consulta</Button></Alert>}
    <Card className="incident-detail">
      <div className="incident-detail__meta"><Badge>{states[incident.status]}</Badge><span>Versión {incident.version}</span><time dateTime={notice.createdAt}>{formatInstant(notice.createdAt, DEFAULT_TIME_ZONE)}</time></div>
      <h2>{notice.lot.description}</h2>
      <div className="incident-detail__context">
        <p className="incident-detail__delivery">{incident.relation === 'received'
          ? 'Con entrega: recibiste packs de este lote antes de fijarse esta versión.'
          : incident.relation === 'committed'
            ? 'Sin entrega registrada al fijarse esta versión: tuviste un compromiso con este lote.'
            : 'Recibes este aviso como operador del establecimiento, sin entrega registrada para ti al fijarse esta versión.'}</p>
        <p className="incident-detail__closure">{incident.lotClosed ? 'El lote estaba cerrado al publicarse esta versión.' : 'El lote estaba abierto al publicarse esta versión.'} El estado mostrado corresponde a esta versión publicada.</p>
      </div>
      <section className="incident-detail__text"><h3>Motivo</h3><p>{incident.reason}</p></section>
      <section className="incident-detail__text"><h3>Instrucciones</h3><p>{incident.instructions}</p></section>
      <div className="incident-detail__read">
        <p role="status">{notice.readAt ? `Lectura registrada: ${formatInstant(notice.readAt, DEFAULT_TIME_ZONE)}.` : 'Lectura pendiente de registrar.'}</p>
        <Button className="incident-detail__action" onClick={() => { void read() }} loading={reading} disabled={notice.readAt !== null || refreshing}>{notice.readAt ? 'Leído' : 'Marcar como leído'}</Button>
        <p className="incident-detail__disclaimer">Registrar la lectura solo indica que leíste este aviso. No acredita que hayas cumplido las instrucciones.</p>
      </div>
    </Card>
  </section>
}

export function IncidentNoticePage() {
  const { id = '' } = useParams()
  const { status, session, csrfToken, error, refreshSession } = useAuth()
  const location = useLocation()
  let content
  if (status === 'error') content = <Alert tone="danger" role="alert">{error}<Button onClick={() => { void refreshSession() }}>Reintentar sesión</Button></Alert>
  else if (status === 'checking' || status === 'signing-out') content = <IncidentSkeleton />
  else if (!session || !csrfToken) content = <Alert>Inicia sesión para leer tus incidencias. <Link to={`/login?from=${encodeURIComponent(location.pathname)}`}>Iniciar sesión</Link></Alert>
  else content = <Notice key={`${session.user.id}:${id}`} id={id} csrfToken={csrfToken} />
  return <main className="page-content"><div className="notifications">
    <Link to="/incidencias">Volver al historial de incidencias</Link><h1>Incidencia del lote</h1>
    <p>Motivo e instrucciones de la versión publicada, disponibles aunque el lote esté cerrado y el chat terminado. Horarios en {DEFAULT_TIME_ZONE}.</p>
    {content}
  </div></main>
}
