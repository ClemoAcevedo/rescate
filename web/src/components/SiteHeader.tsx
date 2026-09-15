import { Link, NavLink } from 'react-router-dom'

const navigationItems = [
  { to: '/lotes', label: 'Explorar lotes' },
  { to: '/registro', label: 'Registro' },
  { to: '/login', label: 'Iniciar sesión' },
]

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link className="brand" to="/lotes" aria-label="Rescate, explorar lotes">
        Rescate
      </Link>
      <nav className="main-navigation" aria-label="Navegación principal">
        {navigationItems.map(({ to, label }) => (
          <NavLink
            key={to}
            className={({ isActive }) =>
              isActive
                ? "main-navigation__link main-navigation__link--active"
                : "main-navigation__link"
            }
            to={to}
          >
            {label}
          </NavLink>
        ))}
      </nav>
    </header>
  )
}
