import './incidents.css'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Icon } from '../components/Icon'
import { IncidentHistory, NoticeCounts } from '../components/incidents/IncidentHistory'
import { IncidentVersionForm } from '../components/incidents/IncidentVersionForm'
import { ReportIncidentForm } from '../components/incidents/ReportIncidentForm'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Select } from '../components/ui/FormControls'
import { FormField } from '../components/ui/FormField'
import { DEFAULT_TIME_ZONE, formatInstant, formatWindow } from '../format/date-time'
import { incidentStatusLabels, lotIncidentsPath } from '../incidents/incident-labels'
import { lotTitle } from '../lots/lot-title'
import type { OperableEstablishment } from '../services/identity-service'
import { incidentError, listEstablishmentIncidents, listLotIncidents } from '../services/incidents-service'
import type { EstablishmentIncidentPage, Incident, IncidentStatus } from '../services/incidents-service'
import { LotRequestError, getLot, type LotResponse } from '../services/lots-service'

const description = 'Reportes de problemas sobre tus lotes, los avisos publicados y su seguimiento.'

/** Sesión y permiso de operador; la API vuelve a comprobar la membresía en cada consulta. */
function OperatorGate({ title, children }: { title: string; children: (establishments: OperableEstablishment[], csrfToken: string) => ReactNode }) {
  const { status, session, csrfToken } = useAuth()
  const { pathname } = useLocation()
  let content: ReactNode
  if (status === 'checking' || status === 'error' || (session && !csrfToken)) {
    content = <Alert role="status">{status === 'error' ? 'No fue posible comprobar la sesión. Reintenta desde el aviso superior.' : 'Comprobando la sesión…'}</Alert>
  } else if (!session) {
    content = <Card as="section" className="content-card"><p>Inicia sesión con una cuenta habilitada por un establecimiento.</p>
      <Link className="text-link" to={`/login?from=${encodeURIComponent(pathname)}`}>Iniciar sesión</Link></Card>
  } else if (session.operableEstablishments.length === 0) {
    content = <Card as="section" className="content-card"><p>Tu cuenta todavía no está habilitada para operar un establecimiento. La habilitación se gestiona por separado.</p></Card>
  } else return <main className="page-content"><div className="incidents">{children(session.operableEstablishments, csrfToken!)}</div></main>
  return <main className="page-content"><div className="incidents">
    <header className="page-header"><div><p className="eyebrow">Operación</p><h1>{title}</h1><p>{description}</p></div></header>
    {content}
  </div></main>
}

const tabs: { value: string | null; status?: IncidentStatus; label: string }[] = [
  { value: null, label: 'Todas' },
  { value: 'por-revisar', status: 'reported', label: 'Por revisar' },
  { value: 'publicadas', status: 'open', label: 'Publicadas' },
  { value: 'seguimiento', status: 'following', label: 'En seguimiento' },
  { value: 'resueltas', status: 'resolved', label: 'Resueltas' },
]

function Overview({ establishments }: { establishments: OperableEstablishment[] }) {
  const [params, setParams] = useSearchParams()
  const establishment = establishments.find(item => item.id === params.get('establecimiento')) ?? establishments[0]!
  const tab = tabs.find(item => item.value === params.get('estado')) ?? tabs[0]!
  const page = Math.max(1, Math.min(1000, Number(params.get('pagina')) || 1))
  const [refresh, setRefresh] = useState(0)
  const key = `${establishment.id}:${tab.status ?? ''}:${page}:${refresh}`
  const [state, setState] = useState<{ key: string; value: EstablishmentIncidentPage | null; error: string | null }>({ key: '', value: null, error: null })
  useEffect(() => {
    const controller = new AbortController()
    listEstablishmentIncidents(establishment.id, { status: tab.status, page }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setState({ key, value, error: null }) })
      .catch(reason => { if (!controller.signal.aborted) setState({ key, value: null, error: incidentError(reason, 'El establecimiento no existe.') }) })
    return () => controller.abort()
  }, [establishment.id, tab.status, page, key])
  const loading = state.key !== key
  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [name, value] of Object.entries(changes)) if (value) next.set(name, value); else next.delete(name)
    setParams(next)
  }

  return (
    <div aria-busy={loading}>
      <header className="page-header"><div><p className="eyebrow">Operación</p><h1>Incidencias</h1><p>{description}</p></div></header>
      <div className="my-lots__toolbar">
        {establishments.length > 1
          ? <FormField label="Establecimiento">{control => (
            <Select {...control} value={establishment.id} onChange={event => update({ establecimiento: event.target.value, pagina: null })}>
              {establishments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          )}</FormField>
          : <p className="my-lots__establishment"><Icon name="pin" />{establishment.name}</p>}
        <Button variant="secondary" loading={loading && state.value !== null} onClick={() => setRefresh(value => value + 1)}>Actualizar</Button>
      </div>
      <nav className="segmented incidents__tabs" aria-label="Filtrar incidencias">
        {tabs.map(item => (
          <Link key={item.label} className="segmented__item" aria-current={item === tab ? 'page' : undefined}
            to={{ search: (() => { const next = new URLSearchParams(params); next.delete('pagina'); if (item.value) next.set('estado', item.value); else next.delete('estado'); return `?${next}` })() }}>
            {item.label}
          </Link>
        ))}
      </nav>
      <p className="incidents__hint">Para reportar un problema o publicar un aviso, abre las incidencias del lote desde «Mis lotes».</p>
      {state.error && <Alert tone="danger" role="alert">{state.error}</Alert>}
      {loading && !state.value && !state.error && <p role="status">Cargando incidencias…</p>}
      {state.value && state.value.items.length === 0 && <Card className="empty-state">
        <span className="empty-state__icon"><Icon name="info" /></span><h2>No hay incidencias{tab.status ? ` ${tab.label.toLowerCase()}` : ''}</h2>
        <p>Cuando alguien reporte un problema con un lote del establecimiento, aparecerá aquí para que lo revises.</p>
      </Card>}
      {state.value && state.value.items.length > 0 && (
        <ul className="incidents__list">
          {state.value.items.map(item => {
            const latest = item.versions.at(-1)
            return (
              <li key={item.id}>
                <Card as="article" className="incident-summary">
                  <div className="incident-summary__head">
                    <Badge tone={incidentStatusLabels[item.status].tone}>{incidentStatusLabels[item.status].label}</Badge>
                    <h2><Link to={lotIncidentsPath(item.lot.id, item.id)}>{lotTitle(item.lot.description)}</Link></h2>
                  </div>
                  <p className="incident-summary__reason">{item.reportReason}</p>
                  <p className="incident-summary__meta">Reportado el <time dateTime={item.reportedAt}>{formatInstant(item.reportedAt, DEFAULT_TIME_ZONE)}</time></p>
                  {latest
                    ? <><p className="incident-summary__meta">Versión {latest.version} publicada por <strong>{latest.publishedBy}</strong> el {formatInstant(latest.publishedAt, DEFAULT_TIME_ZONE)}</p>
                      <NoticeCounts version={latest} /></>
                    : <p className="incident-summary__meta">Sin publicar: nadie ha recibido avisos.</p>}
                  <Link className="ui-button ui-button--secondary" to={lotIncidentsPath(item.lot.id, item.id)}>{item.status === 'reported' ? 'Revisar y publicar' : 'Ver y gestionar'}</Link>
                </Card>
              </li>
            )
          })}
        </ul>
      )}
      {state.value && (state.value.page > 1 || state.value.hasNextPage) && (
        <nav className="panel-pagination" aria-label="Páginas de incidencias">
          {state.value.page > 1 && <Button variant="secondary" onClick={() => update({ pagina: state.value!.page === 2 ? null : String(state.value!.page - 1) })}>Más recientes</Button>}
          <span aria-current="page">Página {state.value.page}</span>
          {state.value.hasNextPage && <Button variant="secondary" onClick={() => update({ pagina: String(state.value!.page + 1) })}>Anteriores</Button>}
        </nav>
      )}
    </div>
  )
}

export function OperatorIncidentsPage() {
  return <OperatorGate title="Incidencias">{establishments => <Overview establishments={establishments} />}</OperatorGate>
}

type LotState = { lot: LotResponse; incidents: Incident[] }

function LotIncidents({ lotId, csrfToken }: { lotId: string; csrfToken: string }) {
  const { hash } = useLocation()
  const [refresh, setRefresh] = useState(0)
  const key = `${lotId}:${refresh}`
  // El cierre se compara con el reloj de la carga, como el resto de las vistas del operador.
  const [state, setState] = useState<{ key: string; data: LotState | null; error: string | null; loadedAt: number }>(
    { key: '', data: null, error: null, loadedAt: 0 })
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    // Primero el lote: su error (inexistente o de otro establecimiento) es el que se explica.
    getLot(lotId, controller.signal)
      .then(async lot => [lot, await listLotIncidents(lotId, controller.signal)] as const)
      .then(([lot, incidents]) => { if (!controller.signal.aborted) setState({ key, data: { lot, incidents }, error: null, loadedAt: Date.now() }) })
      .catch(reason => {
        if (controller.signal.aborted) return
        setState(current => ({ ...current, key, error: reason instanceof LotRequestError
          ? reason.status === 403 ? 'Tu cuenta no opera el establecimiento de este lote.' : reason.status === 404 ? 'El lote no existe.' : reason.error.message
          : incidentError(reason, 'El lote no existe o no opera en tu establecimiento.') }))
      })
    return () => controller.abort()
  }, [lotId, key])
  const { data, error, loadedAt } = state
  const loading = state.key !== key
  const reload = () => setRefresh(value => value + 1)
  // Al llegar desde la lista general, llevar a la incidencia elegida cuando ya está en pantalla.
  useEffect(() => {
    if (data && hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: 'start' })
  }, [data, hash])

  const lot = data?.lot
  const open = lot ? lot.status === 'published' && Date.parse(lot.pickupEndsAt) > loadedAt : false
  const closedLabel = lot?.status === 'withdrawn' ? 'Publicación retirada' : lot?.status === 'draft' ? 'Borrador' : 'Retiro finalizado'
  return (
    <div aria-busy={loading}>
      <header className="page-header">
        <div><p className="eyebrow">Operación</p><h1>Incidencias del lote</h1>
          {lot ? <p>{lotTitle(lot.description)}</p> : <p>{description}</p>}</div>
        <Button variant="secondary" loading={loading && data !== null} onClick={() => { setNotice(null); reload() }}>Actualizar</Button>
      </header>
      <nav className="incidents__links" aria-label="Relacionado">
        <Link to="/operador/incidencias">Todas las incidencias</Link>
        {lot && <Link to={`/operador/lotes/${encodeURIComponent(lot.id)}`}>Ver lote</Link>}
      </nav>
      {error && <Alert tone="danger" role="alert">{error}</Alert>}
      {loading && !data && !error && <p role="status">Cargando incidencias del lote…</p>}
      {notice && <Alert tone="success" role="status">{notice}</Alert>}
      {lot && data && <>
        <Card as="section" className="incident-lot" aria-label="Estado del lote">
          <Badge tone={open ? 'success' : 'neutral'}>{open ? 'Publicado' : closedLabel}</Badge>
          <p><Icon name="clock" />{formatWindow(lot.pickupStartsAt, lot.pickupEndsAt, lot.timeZone)}</p>
          {!open && <p>El lote está cerrado: las nuevas versiones avisan, pero no cambian reservas ni códigos.</p>}
        </Card>
        {lot.status !== 'draft' && (
          <Card as="section" className="incident-report" aria-labelledby="incident-report-title">
            <h2 id="incident-report-title">Reportar un problema</h2>
            <p>El reporte queda por revisar. No avisa a nadie ni cierra el lote hasta que publiques una versión.</p>
            <ReportIncidentForm lotId={lot.id} csrfToken={csrfToken} label="Problema detectado" hint="Hasta 2000 caracteres."
              onReported={() => { setNotice('Reporte registrado: queda por revisar.'); reload() }} />
          </Card>
        )}
        <section aria-labelledby="incident-list-title">
          <h2 id="incident-list-title">Incidencias</h2>
          {data.incidents.length === 0
            ? <p className="incident__empty">No hay incidencias en este lote.</p>
            : <ul className="incidents__list">{data.incidents.map(incident => (
              <li key={incident.id} id={`incidencia-${incident.id}`}>
                <Card as="article" className="incident" aria-labelledby={`incidencia-${incident.id}-title`}>
                  <div className="incident-summary__head">
                    <Badge tone={incidentStatusLabels[incident.status].tone}>{incidentStatusLabels[incident.status].label}</Badge>
                    <h3 id={`incidencia-${incident.id}-title`}>Reporte del <time dateTime={incident.reportedAt}>{formatInstant(incident.reportedAt, lot.timeZone)}</time></h3>
                  </div>
                  <p className="incident-summary__reason">{incident.reportReason}</p>
                  <h4>Versiones publicadas</h4>
                  <IncidentHistory versions={incident.versions} timeZone={lot.timeZone} />
                  {incident.status !== 'resolved' && <h4>{incident.status === 'reported' ? 'Publicar a las personas vinculadas' : 'Nueva versión'}</h4>}
                  <IncidentVersionForm key={`${incident.id}:${incident.version}`} incident={incident} lotOpen={open} csrfToken={csrfToken}
                    onPublished={result => { setNotice(`Versión ${result.version} publicada${result.closeLot ? ' y lote cerrado' : ''}. Los avisos se generan en segundo plano.`); reload() }} />
                </Card>
              </li>
            ))}</ul>}
        </section>
      </>}
    </div>
  )
}

export function LotIncidentsPage() {
  const { lotId = '' } = useParams()
  return <OperatorGate title="Incidencias del lote">{(_, csrfToken) => <LotIncidents lotId={lotId} csrfToken={csrfToken} />}</OperatorGate>
}
