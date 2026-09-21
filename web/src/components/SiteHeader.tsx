import { useEffect, useRef, useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { Button } from './ui/Button'
import { RescateLogo } from './RescateLogo'

const navigationItems = [
  { to: '/lotes', label: 'Explorar lotes' },
  { to: '/registro', label: 'Registro' },
  { to: '/login', label: 'Iniciar sesión' },
]

export function SiteHeader() {
  const menuButton = useRef<HTMLButtonElement>(null)
  const navigation = useRef<HTMLElement>(null)
  const [isMenuOpen, setIsMenuOpen] = useState(false)

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
