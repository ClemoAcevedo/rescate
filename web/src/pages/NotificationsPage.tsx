import './notifications.css'
import { useCallback, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { lotTitle } from '../lots/lot-title'
import { setUnreadCount } from '../notifications/unread'
import { NOTIFICATION_POLL_MS, useVisiblePolling } from '../notifications/use-visible-polling'
import {
  listNotifications, markNotificationRead, notificationError, type Notification, type NotificationPage,
} from '../services/notifications-service'

const when = (instant: string) => new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeStyle: 'short' }).format(Date.parse(instant))
const packs = (quantity: number) => `${quantity} ${quantity === 1 ? 'pack' : 'packs'}`

/** Texto y destino de cada aviso. El destino muestra el estado vigente: un aviso nunca confirma nada. */
function describe(notification: Notification): { title: string; text: string; action: string; to: string } {
  const entry = `/espera/${encodeURIComponent(notification.waitlistEntryId ?? '')}`
  const reservation = `/reservas/${encodeURIComponent(notification.reservationId ?? '')}`
  switch (notification.kind) {
    case 'offer_issued':
      return { title: `Tienes una oferta por ${packs(notification.quantity)}`, action: 'Ver oferta', to: entry,
        text: `Puedes aceptarla hasta ${notification.offerExpiresAt ? when(notification.offerExpiresAt) : 'su vencimiento'} (el plazo se vuelve a comprobar al aceptar).` }
    case 'offer_expired':
      return { title: 'Tu oferta venció', action: 'Ver solicitud', to: entry,
        text: `La oferta por ${packs(notification.quantity)} venció sin aceptarse y la solicitud salió de la cola. Para volver a esperar debes ingresar de nuevo.` }
    case 'reservation_confirmed':
      return { title: 'Reserva confirmada', action: 'Ver reserva', to: reservation,
        text: `Aceptaste la oferta por ${packs(notification.quantity)}. Consulta tu código de retiro en el detalle de la reserva.` }
    case 'reservation_cancelled':
      return { title: 'Reserva cancelada', action: 'Ver reserva', to: reservation,
        text: `Cancelaste tu reserva de ${packs(notification.quantity)}. Los packs quedaron disponibles para otras personas.` }
    // El aviso no trae el texto del mensaje, que solo se lee dentro de la conversación
    case 'message_from_establishment':
      return { title: 'Mensaje del establecimiento', action: 'Abrir conversación', to: `${reservation}/chat`,
        text: `Te escribieron sobre tu reserva de ${packs(notification.quantity)}.` }
    case 'message_from_holder':
      return { title: 'Mensaje de quien reservó', action: 'Abrir conversación', to: `${reservation}/chat`,
        text: `Te escribieron sobre una reserva de ${packs(notification.quantity)}.` }
  }
}

function Inbox({ csrfToken }: { csrfToken: string }) {
  const [params, setParams] = useSearchParams()
  const requested = Number(params.get('pagina') ?? 1)
  const page = Number.isSafeInteger(requested) && requested >= 1 && requested <= 1000 ? requested : 1
  const [result, setResult] = useState<NotificationPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const loading = useRef(false)
  const navigate = useNavigate()

  const load = useCallback(() => {
    if (loading.current) return
    loading.current = true
    listNotifications(page)
      .then(value => { setResult(value); setError(null); setUnreadCount(value.unreadCount) })
      .catch(reason => setError(notificationError(reason)))
      .finally(() => { loading.current = false })
  }, [page])
  useVisiblePolling(load, NOTIFICATION_POLL_MS)

  /** Abrir registra la lectura y lleva al detalle vigente; si la lectura falla, igual se navega. */
  const open = async (notification: Notification, to: string) => {
    if (opening) return
    setOpening(notification.id)
    try {
      if (!notification.readAt) {
        const read = await markNotificationRead(notification.id, csrfToken)
        const remaining = Math.max(0, (result?.unreadCount ?? 1) - 1)
        setResult(current => current && { ...current, unreadCount: remaining,
          items: current.items.map(item => item.id === read.id ? read : item) })
        setUnreadCount(remaining)
      }
    } catch { /* la lectura se reintenta al volver a abrir el aviso */ }
    finally { setOpening(null) }
    navigate(to)
  }

  if (!result) {
    return error
      ? <Alert tone="danger" role="alert"><p>{error}</p><Button variant="secondary" onClick={load}>Reintentar</Button></Alert>
      : <Alert role="status">Cargando avisos…</Alert>
  }
  return (
    <section aria-label="Bandeja de avisos">
      {error && <Alert tone="warning" role="status">{error}</Alert>}
      <p className="notifications__summary" role="status">
        {result.unreadCount === 0 ? 'No tienes avisos sin leer.' : `${result.unreadCount} ${result.unreadCount === 1 ? 'aviso sin leer' : 'avisos sin leer'}.`}
      </p>
      {result.items.length === 0 && <Card>No hay avisos en esta página. Aquí verás ofertas, vencimientos, confirmaciones y cancelaciones.</Card>}
      <ul className="notifications__list">
        {result.items.map(notification => {
          const view = describe(notification)
          const unread = notification.readAt === null
          return (
            <li key={notification.id}>
              <Card as="article" className={`notification${unread ? ' notification--unread' : ''}`} aria-label={view.title}>
                <div className="notification__heading">
                  <h2>{view.title}</h2>
                  {unread && <Badge tone="info">Nuevo</Badge>}
                </div>
                <p className="notification__lot">{lotTitle(notification.lot.description)}</p>
                <p>{view.text}</p>
                <div className="notification__footer">
                  <time dateTime={notification.createdAt}>{when(notification.createdAt)}</time>
                  <Button variant={unread ? 'primary' : 'secondary'} loading={opening === notification.id}
                    disabled={opening !== null} onClick={() => { void open(notification, view.to) }}>{view.action}</Button>
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

export function NotificationsPage() {
  const { status, session, csrfToken, error, refreshSession } = useAuth()
  const location = useLocation()
  let content
  if (status === 'error') content = <Alert tone="danger" role="alert">{error}<Button onClick={() => { void refreshSession() }}>Reintentar sesión</Button></Alert>
  else if (status === 'checking' || (!session && status === 'signing-out')) content = <Alert role="status">Comprobando la sesión…</Alert>
  else if (!session || !csrfToken) content = <Alert>Inicia sesión para ver tus avisos. <Link to={`/login?from=${encodeURIComponent(location.pathname + location.search)}`}>Iniciar sesión</Link></Alert>
  else content = <Inbox key={session.user.id} csrfToken={csrfToken} />
  return (
    <main className="page-content">
      <div className="notifications">
        <h1>Avisos</h1>
        <p>Ofertas, vencimientos, confirmaciones y cancelaciones de tus solicitudes y reservas. Se guardan aunque no estés conectado.</p>
        {content}
      </div>
    </main>
  )
}
