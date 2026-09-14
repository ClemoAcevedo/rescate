import { NavLink, Outlet } from 'react-router-dom'
import { RescateLogo } from '../components/RescateLogo'
import './AppLayout.css'

const navigationItems = [
  { to: '/lotes', label: 'Explorar lotes' },
  { to: '/registro', label: 'Registro' },
  { to: '/login', label: 'Iniciar sesión' },
]

export function AppLayout() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__content">
          <NavLink className="app-header__brand" to="/lotes">
            <RescateLogo />
          </NavLink>
          <nav aria-label="Navegación principal">
            <ul className="app-header__nav-list">
              {navigationItems.map(({ to, label }) => (
                <li key={to}>
                  <NavLink
                    className={({ isActive }) =>
                      `app-header__nav-link${isActive ? ' app-header__nav-link--active' : ''}`
                    }
                    to={to}
                  >
                    {label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}
