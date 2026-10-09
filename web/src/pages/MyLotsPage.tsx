import { useEffect, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Icon } from '../components/Icon'
import { LotPhoto } from '../components/lots/LotPhoto'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Select } from '../components/ui/FormControls'
import { FormField } from '../components/ui/FormField'
import { formatWindow } from '../lots/lot-time'
import { lotStatusBadges } from '../lots/lot-status'
import { lotTitle } from '../lots/lot-title'
import type { OperableEstablishment } from '../services/identity-service'
import { ConnectionError, LotRequestError, listEstablishmentLots, type OperatorLotPage, type OperatorLotSummary } from '../services/lots-service'

const tabs = [
  { value: '', label: 'Todos' },
  { value: 'draft', label: 'Borradores' },
  { value: 'published', label: 'Publicados' },
] as const

function loadError(error: unknown): string {
  if (error instanceof LotRequestError && error.status === 403) return 'Tu cuenta ya no está habilitada para este establecimiento.'
  if (error instanceof LotRequestError && error.status === 401) return 'Tu sesión venció. Inicia sesión nuevamente.'
  if (error instanceof ConnectionError) return 'No fue posible conectar con el servicio. Revisa tu conexión e inténtalo nuevamente.'
  return 'No fue posible cargar tus lotes. Inténtalo nuevamente.'
}

function LotRow({ lot, now }: { lot: OperatorLotSummary; now: number }) {
  const title = lotTitle(lot.description)
  const ended = Date.parse(lot.pickupEndsAt) <= now
  const badge = lotStatusBadges[lot.status]
  const editorPath = `/operador/lotes/${encodeURIComponent(lot.id)}`
  return (
    <li className="my-lot">
      <div className="my-lot__media"><LotPhoto src={lot.photoUrl} description={`Fotografía del pack: ${title}`} /></div>
      <div className="my-lot__body">
        <div className="my-lot__labels">
          {lot.status === 'published' && ended ? <Badge>Retiro finalizado</Badge> : <Badge tone={badge.tone}>{badge.label}</Badge>}
          <span className="my-lot__category">{lot.category}</span>
        </div>
        <h2><Link to={editorPath}>{title}</Link></h2>
        <ul className="lot-meta">
          <li><Icon name="clock" /><span>{formatWindow(lot.pickupStartsAt, lot.pickupEndsAt, lot.timeZone)}</span></li>
          <li><Icon name="box" /><span>{lot.status !== 'draft'
            ? `${lot.reservedQuantity} de ${lot.quantity} ${lot.quantity === 1 ? 'pack reservado' : 'packs reservados'}`
            : `${lot.quantity} ${lot.quantity === 1 ? 'pack' : 'packs'} · sin publicar`}</span></li>
        </ul>
      </div>
      <div className="my-lot__actions">
        <Link className={`ui-button ui-button--${lot.status === 'draft' ? 'primary' : 'secondary'}`} to={editorPath}>
          {lot.status === 'draft' ? 'Continuar borrador' : 'Ver lote'}
        </Link>
        {lot.status === 'published' && !ended && (
          <Link className="ui-button ui-button--ghost" to={`/lotes/${encodeURIComponent(lot.id)}`}><Icon name="eye" />Vista pública</Link>
        )}
      </div>
    </li>
  )
}

function MyLots({ establishments }: { establishments: OperableEstablishment[] }) {
  const [params, setParams] = useSearchParams()
  const requested = params.get('establecimiento')
  const establishment = establishments.find(item => item.id === requested) ?? establishments[0]!
  const status = params.get('estado') === 'draft' || params.get('estado') === 'published' ? params.get('estado') as 'draft' | 'published' : undefined
  const page = Math.max(1, Number(params.get('pagina')) || 1)
  const [result, setResult] = useState<OperatorLotPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  // Instante de referencia para marcar ventanas terminadas; se renueva al recargar la lista.
  const [now, setNow] = useState(() => Date.now())
  const query = `${establishment.id}:${status ?? ''}:${page}:${retry}`
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    listEstablishmentLots(establishment.id, { status, page }, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setResult(value); setError(null); setNow(Date.now()) } })
      .catch(reason => { if (!controller.signal.aborted) { setResult(null); setError(loadError(reason)) } })
      .finally(() => { if (!controller.signal.aborted) setLoadedQuery(query) })
    return () => controller.abort()
  }, [establishment.id, status, page, query])

  const loading = loadedQuery !== query
  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key)
    setParams(next)
  }
  const emptyMessage = status === 'draft' ? 'No tienes borradores pendientes.' : status === 'published' ? 'Aún no has publicado lotes.' : 'Aún no has creado lotes.'

  return (
    <div className="my-lots">
      <header className="page-header">
        <div>
          <p className="eyebrow">Operación</p>
          <h1>Mis lotes</h1>
          <p>Retoma tus borradores y revisa cómo van las reservas de lo que publicaste.</p>
        </div>
        <Link className="ui-button ui-button--primary" to="/operador/lotes/nuevo"><Icon name="plus" />Publicar lote</Link>
      </header>
      <div className="my-lots__toolbar">
        {establishments.length > 1
          ? <FormField label="Establecimiento">{control => (
            <Select {...control} value={establishment.id} onChange={event => update({ establecimiento: event.target.value, pagina: null })}>
              {establishments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          )}</FormField>
          : <p className="my-lots__establishment"><Icon name="pin" />{establishment.name}</p>}
        <nav className="segmented" aria-label="Filtrar por estado">
          {tabs.map(tab => (
            <Link key={tab.value} className="segmented__item" aria-current={(status ?? '') === tab.value ? 'page' : undefined}
              to={{ search: (() => { const next = new URLSearchParams(params); next.delete('pagina'); if (tab.value) next.set('estado', tab.value); else next.delete('estado'); return `?${next}` })() }}>
              {tab.label}
            </Link>
          ))}
        </nav>
      </div>
      <section aria-label="Lotes del establecimiento" aria-busy={loading}>
        {loading && !result && <p className="my-lots__status" role="status">Cargando tus lotes…</p>}
        {error && <Alert tone="danger" role="alert">{error} <Button variant="secondary" onClick={() => setRetry(value => value + 1)}>Reintentar</Button></Alert>}
        {result && result.items.length === 0 && (
          <Card className="empty-state">
            <span className="empty-state__icon"><Icon name="box" /></span>
            <h2>{emptyMessage}</h2>
            <p>Un lote empieza como borrador: puedes guardarlo, agregar fotos y publicarlo cuando esté listo.</p>
            <Link className="ui-button ui-button--primary" to="/operador/lotes/nuevo"><Icon name="plus" />Crear un lote</Link>
          </Card>
        )}
        {result && result.items.length > 0 && <ul className="my-lots__list">{result.items.map(lot => <LotRow key={lot.id} lot={lot} now={now} />)}</ul>}
        {result && (page > 1 || result.hasNextPage) && (
          <nav className="explore-pagination" aria-label="Páginas de lotes">
            {page > 1 && <Button variant="secondary" onClick={() => update({ pagina: page - 1 === 1 ? null : String(page - 1) })}>Página anterior</Button>}
            <span aria-current="page">Página {result.page}</span>
            {result.hasNextPage && <Button variant="secondary" onClick={() => update({ pagina: String(page + 1) })}>Página siguiente</Button>}
          </nav>
        )}
      </section>
    </div>
  )
}

export function MyLotsPage() {
  const { status, session } = useAuth()
  const { pathname } = useLocation()
  if (status === 'checking' || status === 'error') {
    return <main className="page-content"><div className="my-lots"><p className="my-lots__status" role="status">Comprobando la sesión…</p></div></main>
  }
  if (!session) {
    return <main className="page-content"><Card as="section" className="content-card lot-card" aria-labelledby="my-lots-title">
      <p className="eyebrow">Operación</p><h1 id="my-lots-title">Mis lotes</h1>
      <p>Inicia sesión con una cuenta habilitada por un establecimiento para ver sus lotes.</p>
      <Link className="text-link" to={`/login?from=${encodeURIComponent(pathname)}`}>Iniciar sesión</Link>
    </Card></main>
  }
  if (session.operableEstablishments.length === 0) {
    return <main className="page-content"><Card as="section" className="content-card lot-card" aria-labelledby="my-lots-title">
      <p className="eyebrow">Operación</p><h1 id="my-lots-title">Mis lotes</h1>
      <p>Tu cuenta todavía no está habilitada para operar un establecimiento. La habilitación se gestiona por separado.</p>
    </Card></main>
  }
  return <main className="page-content"><MyLots establishments={session.operableEstablishments} /></main>
}
