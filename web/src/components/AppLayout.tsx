import { Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { RescateLogo } from './RescateLogo'
import { SiteHeader } from './SiteHeader'
import { Alert } from './ui/Alert'

export function AppLayout() {
  const { status, error, refreshSession } = useAuth()
  return (
    <div className="app-shell">
      <SiteHeader />
      {error && (
        <div className="session-notice" role="region" aria-label="Estado de la sesión">
          <Alert tone="danger" role="alert">
            <p>{error}</p>
            {status === 'error' && <button className="session-notice__retry" type="button" onClick={() => { void refreshSession() }}>
              Reintentar comprobación
            </button>}
          </Alert>
        </div>
      )}
      <Outlet />
      <footer className="site-footer">
        <div className="site-footer__inner">
          <RescateLogo className="site-footer__brand" />
          <p>Excedentes de alimentos que llegan a quien los necesita. Retiro presencial, sin pagos.</p>
        </div>
      </footer>
    </div>
  )
}
