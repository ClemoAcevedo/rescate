import { useEffect, useRef, useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { Button } from './ui/Button'
import { Icon } from './Icon'
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
  const navigationItems = session
    ? [{ to: '/lotes', label: 'Explorar lotes', end: false }, ...(isOperator ? [{ to: '/operador/lotes', label: 'Mis lotes', end: true }] : [])]
    : [{ to: '/lotes', label: 'Explorar lotes', end: false }, { to: '/registro', label: 'Registro', end: false }]

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
        {navigationItems.map(({ to, label, end }) => (
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
        ))}
        {isOperator && (
          <NavLink className="ui-button ui-button--primary main-navigation__cta" to="/operador/lotes/nuevo" onClick={closeMenu}>
            <Icon name="plus" />Publicar lote
          </NavLink>
        )}
        {!session && status !== 'checking' && (
          <NavLink className="ui-button ui-button--secondary main-navigation__cta" to="/login" onClick={closeMenu}>Iniciar sesión</NavLink>
        )}
        {session && (
          <span className="session-status" title={session.user.email}>
            <span className="session-status__avatar" aria-hidden="true">{session.user.email.slice(0, 1).toUpperCase()}</span>
            <span className="session-status__email"><span className="visually-hidden">Sesión: </span>{session.user.email}</span>
          </span>
        )}
        {session && <Button variant="ghost" loading={status === 'signing-out'} onClick={() => { void logout() }}>Cerrar sesión</Button>}
      </nav>
    </header>
    </div>
  )
}
