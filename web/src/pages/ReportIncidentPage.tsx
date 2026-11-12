import './incidents.css'
import { useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { ReportIncidentForm } from '../components/incidents/ReportIncidentForm'
import { Alert } from '../components/ui/Alert'
import { Card } from '../components/ui/Card'
import { lotTitle } from '../lots/lot-title'

/**
 * Quien tiene o tuvo una reserva o una espera en el lote reporta un problema. El reporte queda
 * por revisar: no cancela su reserva, no cierra el lote ni avisa a nadie hasta que el
 * establecimiento publique una versión.
 */
export function ReportIncidentPage() {
  const { id = '' } = useParams()
  const { pathname, state } = useLocation()
  const { status, session, csrfToken } = useAuth()
  const [sent, setSent] = useState(false)
  // El título viene del enlace de origen; sin él la página sigue sirviendo con el identificador.
  const lotDescription = typeof (state as { lotDescription?: unknown } | null)?.lotDescription === 'string'
    ? (state as { lotDescription: string }).lotDescription : null

  let content
  if (status === 'checking' || status === 'error' || (session && !csrfToken)) {
    content = <Alert role="status">{status === 'error' ? 'No fue posible comprobar la sesión. Reintenta desde el aviso superior.' : 'Comprobando la sesión…'}</Alert>
  } else if (!session) {
    content = <Alert>Inicia sesión para reportar un problema. <Link to={`/login?from=${encodeURIComponent(pathname)}`}>Iniciar sesión</Link></Alert>
  } else if (sent) {
    content = <Alert tone="success" role="status">
      <p>Reporte enviado. El establecimiento lo revisará y, si corresponde, publicará un aviso con instrucciones.</p>
      <p>Reportar no cancela tu reserva ni tu espera. Los avisos llegan a <Link to="/avisos">Avisos</Link> y al <Link to="/incidencias">historial de incidencias</Link>.</p>
    </Alert>
  } else {
    content = <ReportIncidentForm lotId={id} csrfToken={csrfToken!} label="¿Qué problema encontraste?"
      hint="Por ejemplo, el estado del alimento o algo distinto a lo publicado. Hasta 2000 caracteres."
      onReported={() => setSent(true)} />
  }

  return (
    <main className="page-content"><div className="incidents incidents--narrow">
      <Card as="section" className="incident-report" aria-labelledby="report-title">
        <p className="eyebrow">Incidencia</p>
        <h1 id="report-title">Reportar un problema con el lote</h1>
        {lotDescription && <p className="incident-report__lot">{lotTitle(lotDescription)}</p>}
        <p>El establecimiento revisa cada reporte antes de avisar. Tu reserva o tu espera siguen igual mientras tanto.</p>
        {content}
        <nav className="incidents__links" aria-label="Volver"><Link to="/reservas">Mis reservas</Link><Link to="/espera">Mis esperas</Link></nav>
      </Card>
    </div></main>
  )
}
