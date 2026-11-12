import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { Button } from './ui/Button'
import { Icon } from './Icon'
import { NotificationsLink } from './NotificationsLink'
import { RescateLogo } from './RescateLogo'
import { useAuth } from '../auth/AuthProvider'

export function SiteHeader() {
  const menuButton = useRef<HTMLButtonElement>(null)
  const navigation = useRef<HTMLElement>(null)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const { status, session, logout } = useAuth()

  useEffect(() => {
    if (!isMenuOpen) {
      return undefined
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (navigation.current?.contains(document.activeElement)) {
          menuButton.current?.focus()
        }
        setIsMenuOpen(false)
      }
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [isMenuOpen])

  const closeMenu = () => setIsMenuOpen(false)
  // El enlace orienta la navegación; la API vuelve a comprobar la membresía en cada operación.
  const isOperator = Boolean(session && session.operableEstablishments.length > 0)
  const navLink = (to: string, label: ReactNode, end = false) => (
    <NavLink
      key={to}
      end={end}
      className={({ isActive }) =>
        isActive
          ? 'main-navigation__link main-navigation__link--active'
          : 'main-navigation__link'
      }
      to={to}
      onClick={closeMenu}
    >
      {label}
    </NavLink>
  )

  return (
    <div className="site-header-bar">
    <header className="site-header">
      <Link
        className="brand"
        to="/lotes"
        aria-label="Rescate, explorar lotes"
        onClick={closeMenu}
      >
        <RescateLogo />
      </Link>
      <Button
        ref={menuButton}
        variant="secondary"
        className="menu-toggle"
        type="button"
        aria-controls="main-navigation"
        aria-expanded={isMenuOpen}
        onClick={() => setIsMenuOpen((isOpen) => !isOpen)}
      >
        {isMenuOpen ? 'Cerrar menú' : 'Abrir menú'}
      </Button>
      <nav
        ref={navigation}
        id="main-navigation"
        className={isMenuOpen ? 'main-navigation main-navigation--open' : 'main-navigation'}
        aria-label="Navegación principal"
      >
        {session ? (
          <>
            <div className="main-navigation__group" role="group" aria-labelledby="navigation-rescue">
              <p className="main-navigation__heading" id="navigation-rescue">Rescatar</p>
              {navLink('/lotes', 'Explorar lotes')}
              {navLink('/espera', 'Mis esperas')}
              {navLink('/reservas', 'Mis reservas')}
            </div>
            {isOperator && (
              <div className="main-navigation__group" role="group" aria-labelledby="navigation-establishment">
                <p className="main-navigation__heading" id="navigation-establishment">Mi establecimiento</p>
                {/* En el menú móvil el grupo ya dice «Mi establecimiento», así que el enlace se acorta a «Panel» */}
                {navLink('/operador/panel', <><span className="main-navigation__wide">Mi establecimiento</span><span className="main-navigation__compact">Panel</span></>, true)}
                {navLink('/operador/lotes', 'Mis lotes', true)}
                <NavLink className="ui-button ui-button--primary main-navigation__cta" to="/operador/lotes/nuevo" onClick={closeMenu}>
                  <Icon name="plus" />Publicar lote
                </NavLink>
              </div>
            )}
            <div className="main-navigation__group main-navigation__account" role="group" aria-labelledby="navigation-account">
              <p className="main-navigation__heading" id="navigation-account">Tu cuenta</p>
              <NotificationsLink key={session.user.id} onNavigate={closeMenu} />
              <span className="session-status" title={session.user.email}>
                <span className="session-status__avatar" aria-hidden="true">{session.user.email.slice(0, 1).toUpperCase()}</span>
                <span className="session-status__email"><span className="visually-hidden">Sesión: </span>{session.user.email}</span>
              </span>
              <Button variant="ghost" loading={status === 'signing-out'} onClick={() => { void logout() }}>Cerrar sesión</Button>
            </div>
          </>
        ) : (
          <>
            {navLink('/lotes', 'Explorar lotes')}
            {navLink('/registro', 'Registro')}
            {status !== 'checking' && (
              <NavLink className="ui-button ui-button--secondary main-navigation__cta" to="/login" onClick={closeMenu}>Iniciar sesión</NavLink>
            )}
          </>
        )}
      </nav>
    </header>
    </div>
  )
}
