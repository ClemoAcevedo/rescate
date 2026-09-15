import { Outlet } from 'react-router-dom'
import { SiteHeader } from './SiteHeader'

export function AppLayout() {
  return (
    <div className="app-shell">
      <SiteHeader />
      <Outlet />
    </div>
  )
}
