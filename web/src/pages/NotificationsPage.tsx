import { NotificationsSkeleton } from './NotificationsSkeleton'
import './notifications.css'
import { DEFAULT_TIME_ZONE, formatInstant } from '../format/date-time'
import { useCallback, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Icon } from '../components/Icon'
import { lotTitle } from '../lots/lot-title'
import { setUnreadCount } from '../notifications/unread'
import { NOTIFICATION_POLL_MS, useVisiblePolling } from '../notifications/use-visible-polling'
import {
  listNotifications, markNotificationRead, notificationError, type Notification, type NotificationPage,
} from '../services/notifications-service'

const when = (instant: string) => formatInstant(instant, DEFAULT_TIME_ZONE)
const packs = (quantity: number) => `${quantity} ${quantity === 1 ? 'pack' : 'packs'}`

/** Texto y destino de cada aviso. El destino muestra el estado vigente: un aviso nunca confirma nada. */
function describe(notification: Notification): { title: string; text: string; action: string; to: string; state?: object } {
  const entry = `/espera/${encodeURIComponent(notification.waitlistEntryId ?? '')}`
  const reservation = `/reservas/${encodeURIComponent(notification.reservationId ?? '')}`
  switch (notification.kind) {
    case 'incident_version': {
      const incident = notification.incident!
      const relation = incident.relation === 'received' ? 'Recibiste packs de este lote.'
        : incident.relation === 'committed' ? 'Tuviste un compromiso con este lote.' : 'Eres operador del establecimiento.'
      return { title: incident.status === 'resolved' ? 'Incidencia resuelta' : 'Aviso de incidencia',
        action: notification.readAt ? 'Leído' : 'Marcar como leído', to: '/avisos',
        text: `${relation} ${incident.reason} Instrucciones: ${incident.instructions}${incident.lotClosed ? ' El lote está cerrado.' : ''}` }
    }
    case 'offer_issued':
      return { title: `Tienes una oferta por ${packs(notification.quantity)}`, action: 'Ver oferta', to: entry,
        text: notification.offerExpiresAt ? `Puedes aceptarla hasta ${when(notification.offerExpiresAt)}.` : 'Acéptala antes de que venza.' }
    case 'offer_expired':
      return { title: 'Tu oferta venció', action: 'Ver tu espera', to: entry,
        text: `La oferta por ${packs(notification.quantity)} venció y saliste de la lista. Si aún te interesa, únete de nuevo.` }
    case 'reservation_confirmed':
      return { title: 'Reserva confirmada', action: 'Ver reserva', to: reservation,
        text: `Reservaste ${packs(notification.quantity)}. Tu código de retiro está en la reserva.` }
    case 'reservation_cancelled':
      return { title: 'Reserva cancelada', action: 'Ver reserva', to: reservation,
        text: `Tu reserva de ${packs(notification.quantity)} fue cancelada.` }
    // El aviso no trae el texto del mensaje, que solo se lee dentro de la conversación
    case 'message_from_establishment':
      return { title: 'Mensaje del establecimiento', action: 'Abrir conversación', to: `${reservation}/chat`,
        state: { lotDescription: notification.lot.description, viewer: 'holder', from: '/avisos' },
        text: `Te escribieron sobre tu reserva de ${packs(notification.quantity)}.` }
    case 'message_from_holder':
      return { title: 'Mensaje de la persona que reservó', action: 'Abrir conversación', to: `${reservation}/chat`,
        state: { lotDescription: notification.lot.description, viewer: 'operator', from: '/avisos' },
        text: `Te escribieron sobre una reserva de ${packs(notification.quantity)}.` }
  }
}

function Inbox({ csrfToken, incidentsOnly }: { csrfToken: string; incidentsOnly: boolean }) {
  const [params, setParams] = useSearchParams()
  const requested = Number(params.get('pagina') ?? 1)
  const page = Number.isSafeInteger(requested) && requested >= 1 && requested <= 1000 ? requested : 1
  const [result, setResult] = useState<NotificationPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const loading = useRef(false)
  const mutating = useRef(false)
  const navigate = useNavigate()

  const load = useCallback(() => {
    if (loading.current || mutating.current) return
    loading.current = true; setRefreshing(true)
    listNotifications(page, undefined, incidentsOnly ? 'incident_version' : undefined)
      .then(value => { setResult(value); setError(null); setUnreadCount(value.unreadCount) })
      .catch(reason => setError(notificationError(reason)))
      .finally(() => { loading.current = false; setRefreshing(false) })
  }, [page, incidentsOnly])
  useVisiblePolling(load, NOTIFICATION_POLL_MS)

  /** Abrir registra la lectura y lleva al detalle vigente; si la lectura falla, igual se navega. */
  const open = async (notification: Notification, to: string, state?: object) => {
    if (mutating.current || (notification.kind === 'incident_version' && loading.current)) return
    mutating.current = true; setError(null)
    setOpening(notification.id)
    try {
      if (!notification.readAt) {
        const read = await markNotificationRead(notification.id, csrfToken)
        const remaining = Math.max(0, (result?.unreadCount ?? 1) - 1)
        setResult(current => current && { ...current, unreadCount: remaining,
          items: current.items.map(item => item.id === read.id ? read : item) })
        setUnreadCount(remaining)
      }
    } catch {
      if (notification.kind === 'incident_version') setError('No se pudo confirmar la lectura. Reintenta; se conserva el primer registro si ya se aplicó.')
    }
    finally { mutating.current = false; setOpening(null) }
    if (notification.kind !== 'incident_version') navigate(to, { state })
  }

  if (!result) {
    return error
      ? <Alert tone="danger" role="alert"><p>{error}</p><Button variant="secondary" onClick={load}>Reintentar</Button></Alert>
      : <NotificationsSkeleton incidentsOnly={incidentsOnly} />
  }
  return (
    <section aria-label="Bandeja de avisos" aria-busy={refreshing}>
      <span className="visually-hidden" role="status">{refreshing ? 'Actualizando avisos…' : ''}</span>
      {error && <Alert tone="warning" role="status">{error}</Alert>}
      <p className="notifications__summary" role="status">
        {result.unreadCount === 0 ? 'No tienes avisos sin leer.' : `${result.unreadCount} ${result.unreadCount === 1 ? 'aviso sin leer' : 'avisos sin leer'}.`}
      </p>
      {result.items.length === 0 && <Card>{incidentsOnly ? 'No hay incidencias en esta página.' : 'No hay avisos en esta página. Aquí verás ofertas, reservas, mensajes e incidencias.'}</Card>}
      <ul className="notifications__list">
        {result.items.map(notification => {
          const view = describe(notification)
          const unread = notification.readAt === null
          return (
            <li key={notification.id}>
              <Card as="article" className={`notification${unread ? ' notification--unread' : ''}${notification.incident ? ' notification--incident' : ''}`} aria-label={view.title}>
                <div className="notification__heading">
                  <h2>{view.title}</h2>
                  {unread && <Badge tone="info">Nuevo</Badge>}
                </div>
                <p className="notification__lot">{lotTitle(notification.lot.description)}</p>
                <p className={notification.kind === 'incident_version' ? 'notification__incident-copy' : undefined}>{view.text}</p>
                {notification.incident && <div className="notification__incident-meta">
                  <p>Versión {notification.incident.version}</p>
                  <Link to={`/incidencias/${encodeURIComponent(notification.id)}`}>Ver incidencia</Link>
                  <p className="notification__read-state">{notification.readAt ? `Leído el ${when(notification.readAt)}.` : 'Sin leer. Marcarlo como leído no indica que cumpliste las instrucciones.'}</p>
                </div>}
                <div className="notification__footer">
                  <time dateTime={notification.createdAt}>{when(notification.createdAt)}</time>
                  <Button variant={unread ? 'primary' : 'secondary'} loading={opening === notification.id}
                    disabled={opening !== null || (notification.kind === 'incident_version' && (notification.readAt !== null || refreshing))} onClick={() => { void open(notification, view.to, view.state) }}>{view.action}</Button>
                </div>
              </Card>
            </li>
          )
        })}
      </ul>
      <nav className="explore-pagination" aria-label="Páginas de avisos">
        {page > 1 && <Button onClick={() => setParams({ pagina: String(page - 1) })}>Página anterior</Button>}
        {result.hasNextPage && <Button onClick={() => setParams({ pagina: String(page + 1) })}>Página siguiente</Button>}
      </nav>
    </section>
  )
}

export function NotificationsPage({ incidentsOnly = false }: { incidentsOnly?: boolean }) {
  const { status, session, csrfToken, error, refreshSession } = useAuth()
  const location = useLocation()
  let content
  if (status === 'error') content = <Alert tone="danger" role="alert">{error}<Button onClick={() => { void refreshSession() }}>Reintentar sesión</Button></Alert>
  else if (status === 'checking' || (!session && status === 'signing-out')) content = <NotificationsSkeleton label="Comprobando la sesión…" incidentsOnly={incidentsOnly} />
  else if (!session || !csrfToken) content = <Alert>Inicia sesión para ver tus avisos. <Link to={`/login?from=${encodeURIComponent(location.pathname + location.search)}`}>Iniciar sesión</Link></Alert>
  else content = <Inbox key={`${session.user.id}:${incidentsOnly}:${location.search}`} csrfToken={csrfToken} incidentsOnly={incidentsOnly} />
  return (
    <main className="page-content">
      <div className="notifications">
        {incidentsOnly && <Link className="back-link" to="/avisos"><Icon name="arrowLeft" />Volver a avisos</Link>}
        <h1>{incidentsOnly ? 'Historial de incidencias' : 'Avisos'}</h1>
        <p>{incidentsOnly ? 'Todas las incidencias que te avisamos, también las ya leídas.' : 'Ofertas, reservas, mensajes e incidencias.'} Horarios en {DEFAULT_TIME_ZONE}.</p>
        {!incidentsOnly && <Link to="/incidencias">Ver historial de incidencias</Link>}
        {content}
      </div>
    </main>
  )
}
