import { useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { setUnreadCount, useUnreadCount } from '../notifications/unread'
import { NOTIFICATION_POLL_MS, useVisiblePolling } from '../notifications/use-visible-polling'
import { listNotifications } from '../services/notifications-service'

/** Enlace a la bandeja con el total sin leer. La bandeja abierta consulta por sí misma. */
export function NotificationsLink({ onNavigate }: { onNavigate: () => void }) {
  const unread = useUnreadCount()
  const { pathname } = useLocation()
  const onInbox = pathname === '/avisos'
  useVisiblePolling(() => {
    listNotifications(1).then(page => setUnreadCount(page.unreadCount)).catch(() => { /* se reintenta en el siguiente ciclo */ })
  }, NOTIFICATION_POLL_MS, !onInbox)
  // El contador pertenece a la sesión que lo consultó: se descarta al desmontar (cierre de sesión).
  useEffect(() => () => setUnreadCount(null), [])

  const label = unread ? `Avisos, ${unread} sin leer` : 'Avisos'
  return (
    <NavLink to="/avisos" aria-label={label} onClick={onNavigate}
      className={({ isActive }) => `main-navigation__link${isActive ? ' main-navigation__link--active' : ''}`}>
      Avisos{unread ? <span className="notifications-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span> : null}
    </NavLink>
  )
}
