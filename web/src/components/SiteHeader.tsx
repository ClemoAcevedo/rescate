import { useEffect, useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { RescateLogo } from './RescateLogo'

const navigationItems = [
  { to: '/lotes', label: 'Explorar lotes' },
  { to: '/registro', label: 'Registro' },
  { to: '/login', label: 'Iniciar sesión' },
]

export function SiteHeader() {
  const [isMenuOpen, setIsMenuOpen] = useState(false)

  useEffect(() => {
    if (!isMenuOpen) {
      return undefined
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMenuOpen(false)
      }
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [isMenuOpen])

  const closeMenu = () => setIsMenuOpen(false)

  return (
    <header className="site-header">
      <Link
        className="brand"
        to="/lotes"
        aria-label="Rescate, explorar lotes"
        onClick={closeMenu}
      >
        <RescateLogo />
      </Link>
      <button
        className="menu-toggle"
        type="button"
        aria-controls="main-navigation"
        aria-expanded={isMenuOpen}
        onClick={() => setIsMenuOpen((isOpen) => !isOpen)}
      >
        {isMenuOpen ? 'Cerrar menú' : 'Abrir menú'}
      </button>
      <nav
        id="main-navigation"
        className={isMenuOpen ? 'main-navigation main-navigation--open' : 'main-navigation'}
        aria-label="Navegación principal"
      >
        {navigationItems.map(({ to, label }) => (
          <NavLink
            key={to}
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
      </nav>
    </header>
  )
}
