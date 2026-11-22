import { useEstablishmentCatalog } from '../components/EstablishmentCatalog'
import { EstablishmentPicker } from '../components/EstablishmentPicker'
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
import { LoadingState, Skeleton } from '../components/ui/Skeleton'
import { DEFAULT_TIME_ZONE, formatInstant, formatWindow } from '../format/date-time'
import { incidentStatusLabels, lotIncidentsPath } from '../incidents/incident-labels'
import { lotTitle } from '../lots/lot-title'
import type { OperableEstablishment } from '../services/identity-service'
import { incidentError, listEstablishmentIncidents, listLotIncidents } from '../services/incidents-service'
import type { EstablishmentIncidentPage, Incident, IncidentStatus } from '../services/incidents-service'
import { LotRequestError, getLot, type LotResponse } from '../services/lots-service'

const description = 'Reportes de problemas sobre tus lotes, los avisos publicados y su seguimiento.'
const reportDescription = 'El reporte queda por revisar. No avisa a nadie ni cierra el lote hasta que publiques una versión.'

/** Sesión y permiso de operador; la API vuelve a comprobar la membresía en cada consulta. */
function OperatorGate({ title, sessionSkeleton, children }: {
  title: string
  sessionSkeleton: ReactNode
  children: (establishments: OperableEstablishment[], csrfToken: string) => ReactNode
}) {
  const { establishments } = useEstablishmentCatalog()
  const { status, session, csrfToken } = useAuth()
  const { pathname } = useLocation()
  let content: ReactNode
  if (status === 'error') {
    content = <Alert role="status">No fue posible comprobar la sesión. Reintenta desde el aviso superior.</Alert>
  } else if (status === 'checking' || (session && !csrfToken)) {
    content = sessionSkeleton
  } else if (!session) {
    content = <Card as="section" className="content-card"><p>Inicia sesión con una cuenta habilitada por un establecimiento.</p>
      <Link className="text-link" to={`/login?from=${encodeURIComponent(pathname)}`}>Iniciar sesión</Link></Card>
  } else if (session.operableEstablishments.length === 0) {
    content = <Card as="section" className="content-card"><p>Tu cuenta todavía no está habilitada para operar un establecimiento. La habilitación se gestiona por separado.</p></Card>
  } else return <main className="page-content"><div className="incidents">{children(establishments, csrfToken!)}</div></main>
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

function OverviewSkeleton({ label = 'Cargando incidencias…' }: { label?: string }) {
  return <LoadingState label={label}>
    <ul className="incidents__list"><li>
      <Card className="incident-summary">
        <div className="incident-summary__head">
          <span className="ui-badge"><Skeleton width="5rem" /></span>
          <h2><Skeleton width="10rem" /></h2>
        </div>
        <p className="incident-summary__reason"><Skeleton width="70%" /></p>
        <p className="incident-summary__meta"><Skeleton width="13rem" /></p>
        <p className="incident-summary__meta"><Skeleton width="16rem" /></p>
        <Skeleton className="skeleton-control" width="10rem" />
      </Card>
    </li></ul>
  </LoadingState>
}

function LotIncidentsSkeleton({ label = 'Cargando incidencias del lote…' }: { label?: string }) {
  return <LoadingState label={label}>
    <div className="incidents__results">
      <Card className="incident-lot">
        <span className="ui-badge"><Skeleton width="5rem" /></span>
        <p><Skeleton width="15rem" /></p>
      </Card>
      <Card className="incident-report">
        <h2><Skeleton width="15rem" /></h2>
        <p><Skeleton>{reportDescription}</Skeleton></p>
        <div className="incident-form">
          <div className="ui-field">
            <span className="ui-field__label"><Skeleton width="14rem" /></span>
            <Skeleton className="incident-skeleton__textarea" />
            <span className="ui-field__description"><Skeleton width="10rem" /></span>
          </div>
          <Skeleton className="skeleton-control" width="10rem" />
        </div>
      </Card>
      <div>
        <h2><Skeleton width="8rem" /></h2>
        <ul className="incidents__list"><li>
          <Card className="incident">
            <div className="incident-summary__head">
              <span className="ui-badge"><Skeleton width="5rem" /></span>
              <h3><Skeleton width="14rem" /></h3>
            </div>
            <p className="incident-summary__reason"><Skeleton width="70%" /></p>
            <h4><Skeleton width="10rem" /></h4>
            <p className="incident__empty"><Skeleton width="15rem" /></p>
          </Card>
        </li></ul>
      </div>
    </div>
  </LoadingState>
}

function Overview({ establishments }: { establishments: OperableEstablishment[] }) {
  const [params, setParams] = useSearchParams()
  const establishment = establishments.find(item => item.id === params.get('establecimiento')?.toLowerCase()) ?? establishments[0]!
  const tab = tabs.find(item => item.value === params.get('estado')) ?? tabs[0]!
  const page = Math.max(1, Math.min(1000, Number(params.get('pagina')) || 1))
  const [refresh, setRefresh] = useState(0)
  const query = `${establishment.id}:${tab.status ?? ''}:${page}`
  const [state, setState] = useState<{ query: string; refresh: number; value: EstablishmentIncidentPage | null; error: string | null }>(
    { query: '', refresh: 0, value: null, error: null })
  const value = state.query === query ? state.value : null
  const loading = state.query !== query || state.refresh !== refresh
  useEffect(() => {
    const controller = new AbortController()
    listEstablishmentIncidents(establishment.id, { status: tab.status, page }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setState({ query, refresh, value, error: null }) })
      .catch(reason => { if (!controller.signal.aborted) setState({ query, refresh, value: null, error: incidentError(reason, 'El establecimiento no existe.') }) })
    return () => controller.abort()
  }, [establishment.id, tab.status, page, query, refresh])
  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [name, value] of Object.entries(changes)) if (value) next.set(name, value); else next.delete(name)
    setParams(next)
  }

  return (
    <div>
      <header className="page-header"><div><p className="eyebrow">Operación</p><h1>Incidencias</h1><p>{description}</p></div></header>
      <div className="my-lots__toolbar">
        {establishments.length > 1
          ? <FormField label="Establecimiento">{control => (
            establishments.length >= 20 ? <EstablishmentPicker {...control} name="establishmentId" options={establishments}
              value={establishment.id} onChange={id => { if (id) update({ establecimiento: id, pagina: null }) }} />
              : <Select {...control} value={establishment.id} onChange={event => update({ establecimiento: event.target.value, pagina: null })}>
                {establishments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </Select>
          )}</FormField>
          : <p className="my-lots__establishment"><Icon name="pin" />{establishment.name}</p>}
        <Button variant="secondary" loading={loading} onClick={() => setRefresh(value => value + 1)}>Actualizar</Button>
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
      {loading && !value && <OverviewSkeleton />}
      {!loading && state.error && <Alert tone="danger" role="alert">{state.error}</Alert>}
      {value && <div className="incidents__results" aria-busy={loading}>
        {value.items.length === 0 && <Card className="empty-state">
          <span className="empty-state__icon"><Icon name="info" /></span><h2>No hay incidencias{tab.status ? ` ${tab.label.toLowerCase()}` : ''}</h2>
          <p>Cuando alguien reporte un problema con un lote del establecimiento, aparecerá aquí para que lo revises.</p>
        </Card>}
        {value.items.length > 0 && (
          <ul className="incidents__list">
            {value.items.map(item => {
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
        {(value.page > 1 || value.hasNextPage) && (
          <nav className="panel-pagination" aria-label="Páginas de incidencias">
            {value.page > 1 && <Button variant="secondary" onClick={() => update({ pagina: value.page === 2 ? null : String(value.page - 1) })}>Más recientes</Button>}
            <span aria-current="page">Página {value.page}</span>
            {value.hasNextPage && <Button variant="secondary" onClick={() => update({ pagina: String(value.page + 1) })}>Anteriores</Button>}
          </nav>
        )}
      </div>}
    </div>
  )
}

export function OperatorIncidentsPage() {
  return <OperatorGate title="Incidencias" sessionSkeleton={<OverviewSkeleton label="Comprobando la sesión…" />}>{establishments => <Overview establishments={establishments} />}</OperatorGate>
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
    <div>
      <header className="page-header">
        <div><p className="eyebrow">Operación</p><h1>Incidencias del lote</h1>
          <p>{lot ? lotTitle(lot.description) : loading ? <Skeleton width="14rem" /> : description}</p></div>
        <Button variant="secondary" loading={loading} onClick={() => { setNotice(null); reload() }}>Actualizar</Button>
      </header>
      <nav className="incidents__links" aria-label="Relacionado">
        <Link to="/operador/incidencias">Todas las incidencias</Link>
        {lot ? <Link to={`/operador/lotes/${encodeURIComponent(lot.id)}`}>Ver lote</Link>
          : loading && <Skeleton width="4rem" />}
      </nav>
      {!loading && error && <Alert tone="danger" role="alert">{error}</Alert>}
      {loading && !data && <LotIncidentsSkeleton />}
      {notice && <Alert tone="success" role="status">{notice}</Alert>}
      {lot && data && <div className="incidents__results" aria-busy={loading}>
        <Card as="section" className="incident-lot" aria-label="Estado del lote">
          <Badge tone={open ? 'success' : 'neutral'}>{open ? 'Publicado' : closedLabel}</Badge>
          <p><Icon name="clock" />{formatWindow(lot.pickupStartsAt, lot.pickupEndsAt, lot.timeZone)}</p>
          {!open && <p>El lote está cerrado: las nuevas versiones avisan, pero no cambian reservas ni códigos.</p>}
        </Card>
        {lot.status !== 'draft' && (
          <Card as="section" className="incident-report" aria-labelledby="incident-report-title">
            <h2 id="incident-report-title">Reportar un problema</h2>
            <p>{reportDescription}</p>
            <ReportIncidentForm lotId={lot.id} csrfToken={csrfToken} label="Problema detectado" hint="Hasta 2000 caracteres." disabled={loading || error !== null}
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
                  <IncidentVersionForm key={`${incident.id}:${incident.version}`} incident={incident} lotOpen={open} csrfToken={csrfToken} disabled={loading || error !== null}
                    onPublished={result => { setNotice(`Versión ${result.version} publicada${result.closeLot ? ' y lote cerrado' : ''}. Los avisos se generan en segundo plano.`); reload() }} />
                </Card>
              </li>
            ))}</ul>}
        </section>
      </div>}
    </div>
  )
}

export function LotIncidentsPage() {
  const { lotId = '' } = useParams()
  return <OperatorGate title="Incidencias del lote" sessionSkeleton={<LotIncidentsSkeleton label="Comprobando la sesión…" />}>
    {(_, csrfToken) => <LotIncidents key={lotId} lotId={lotId} csrfToken={csrfToken} />}</OperatorGate>
}
