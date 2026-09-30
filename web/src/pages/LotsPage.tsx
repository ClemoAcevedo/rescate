import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { LotPhoto } from '../components/lots/LotPhoto'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/FormControls'
import { FormField } from '../components/ui/FormField'
import { formatInstant } from '../lots/lot-time'
import { discoveryError, searchPublicLots, type PublicLotPage } from '../services/discovery-service'

type Filters = { category: string; latitude: string; longitude: string; radiusKm: string; pickupBefore: string }
const emptyFilters: Filters = { category: '', latitude: '', longitude: '', radiusKm: '', pickupBefore: '' }
function fromParams(params: URLSearchParams): Filters {
  const before = params.get('pickupBefore')
  const beforeDate = before && Number.isFinite(Date.parse(before)) ? new Date(before) : null
  return { category: params.get('category') ?? '', latitude: params.get('latitude') ?? '',
    longitude: params.get('longitude') ?? '', radiusKm: params.get('radiusKm') ?? '',
    pickupBefore: beforeDate ? new Date(beforeDate.getTime() - beforeDate.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '' }
}

export function LotsPage() {
  const [params] = useSearchParams()
  return <LotsSearch key={params.toString()} />
}

function LotsSearch() {
  const [params, setParams] = useSearchParams()
  const [filters, setFilters] = useState<Filters>(() => fromParams(params))
  const [result, setResult] = useState<PublicLotPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filterError, setFilterError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [locationMessage, setLocationMessage] = useState<string | null>(null)
  const [locating, setLocating] = useState(false)
  const [locationOpen, setLocationOpen] = useState(Boolean(filters.latitude || filters.longitude || filters.radiusKm))
  const filterErrorRef = useRef<HTMLDivElement>(null)
  const search = params.toString()

  useEffect(() => {
    const controller = new AbortController()
    searchPublicLots(search ? `?${search}` : '', controller.signal)
      .then(page => { if (!controller.signal.aborted) { setResult(page); setError(null) } })
      .catch(reason => { if (!controller.signal.aborted) { setResult(null); setError(discoveryError(reason)) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [search, retry])

  useEffect(() => { if (filterError) filterErrorRef.current?.focus() }, [filterError])

  const clear = () => {
    setFilters(emptyFilters); setFilterError(null); setLocationMessage(null); setLocationOpen(false)
    setLoading(true); setError(null); setResult(null); setParams(new URLSearchParams()); setRetry(value => value + 1)
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (Boolean(filters.latitude.trim()) !== Boolean(filters.longitude.trim())) {
      setFilterError('Completa latitud y longitud para buscar por zona, o deja ambas vacías.'); return
    }
    if (filters.radiusKm.trim() && !filters.latitude.trim()) {
      setFilterError('Ingresa una zona para aplicar el radio.'); return
    }
    if (filters.pickupBefore && !Number.isFinite(new Date(filters.pickupBefore).getTime())) {
      setFilterError('Ingresa una fecha y hora de retiro válidas.'); return
    }
    setFilterError(null)
    const next = new URLSearchParams()
    if (filters.category.trim()) next.set('category', filters.category.trim())
    if (filters.latitude.trim() && filters.longitude.trim()) {
      next.set('latitude', filters.latitude.trim()); next.set('longitude', filters.longitude.trim())
      if (filters.radiusKm.trim()) next.set('radiusKm', filters.radiusKm.trim())
    }
    if (filters.pickupBefore) next.set('pickupBefore', new Date(filters.pickupBefore).toISOString())
    setLoading(true); setError(null); setResult(null); setParams(next); setRetry(value => value + 1)
  }
  const locate = () => {
    if (!navigator.geolocation) { setLocationMessage('Tu navegador no ofrece geolocalización. Ingresa la zona mediante coordenadas.'); return }
    setLocating(true); setLocationMessage(null); setLocationOpen(true)
    navigator.geolocation.getCurrentPosition(position => {
      setFilters(current => ({ ...current, latitude: String(position.coords.latitude.toFixed(5)),
        longitude: String(position.coords.longitude.toFixed(5)), radiusKm: current.radiusKm || '10' }))
      setLocationMessage('Ubicación completada. Pulsa Buscar para aplicarla. La distancia es aproximada.')
      setLocating(false)
    }, () => { setLocationMessage('No se obtuvo tu ubicación. Puedes buscar sin ella o ingresar las coordenadas manualmente.'); setLocating(false) },
    { timeout: 15000, maximumAge: 60000 })
  }
  const change = (key: keyof Filters, value: string) => setFilters(current => ({ ...current, [key]: value }))
  const page = Number(params.get('page') || 1)
  const pageLink = (target: number) => {
    const next = new URLSearchParams(params)
    if (target === 1) next.delete('page'); else next.set('page', String(target))
    return `?${next}`
  }
  const hasFilters = Object.values(filters).some(value => value.trim()) || search !== ''
  return <main className="page-content"><div className="explore-page">
    <header className="explore-header">
      <h1>Encuentra packs para rescatar</h1>
      <p>Explora los lotes, revisa el retiro y reserva los packs que necesitas.</p>
    </header>
    <Card as="section" className="explore-filters" aria-label="Filtros de búsqueda">
      <form className="explore-filters__form" onSubmit={submit}>
        <div className="explore-filters__main">
          <FormField label="Categoría">{control => <Input {...control} maxLength={100} value={filters.category} onChange={event => change('category', event.target.value)} placeholder="Ej. Panadería" />}</FormField>
          <FormField label="Retiro comienza antes de">{control => <Input {...control} type="datetime-local" value={filters.pickupBefore} onChange={event => change('pickupBefore', event.target.value)} />}</FormField>
          <Button type="submit" loading={loading}>{loading ? 'Buscando…' : 'Buscar lotes'}</Button>
        </div>
        <div className="explore-filters__location">
          <Button variant="secondary" loading={locating} onClick={locate}>{locating ? 'Buscando ubicación…' : 'Usar mi ubicación'}</Button>
          <p>Tu ubicación es opcional. También puedes ingresar una zona a mano.</p>
        </div>
        <details className="explore-zone" open={locationOpen} onToggle={event => setLocationOpen(event.currentTarget.open)} onInvalidCapture={event => { event.currentTarget.open = true }}>
          <summary>Zona y radio de búsqueda</summary>
          <div className="explore-filters__fields">
            <FormField label="Latitud de la zona" hint="Ejemplo: -33.45">{control => <Input {...control} type="number" step="any" min={-90} max={90} value={filters.latitude} onChange={event => change('latitude', event.target.value)} />}</FormField>
            <FormField label="Longitud de la zona" hint="Ejemplo: -70.66">{control => <Input {...control} type="number" step="any" min={-180} max={180} value={filters.longitude} onChange={event => change('longitude', event.target.value)} />}</FormField>
            <FormField label="Radio (km)" hint="Hasta 100 km. Completa ambas coordenadas.">{control => <Input {...control} type="number" step="any" min="0.1" max="100" value={filters.radiusKm} onChange={event => change('radiusKm', event.target.value)} />}</FormField>
          </div>
        </details>
        {filterError && <div ref={filterErrorRef} tabIndex={-1}><Alert tone="danger" role="alert">{filterError}</Alert></div>}
        {locationMessage && <Alert role="status">{locationMessage}</Alert>}
        {hasFilters && <div><Button variant="ghost" onClick={clear}>Limpiar filtros</Button></div>}
      </form>
    </Card>
    <section className="explore-results" aria-labelledby="results-heading" aria-busy={loading}>
      <div className="explore-results__heading">
        <h2 id="results-heading">Lotes para explorar</h2>
        <p role="status">{loading ? 'Buscando lotes…' : result && result.items.length > 0
          ? `${result.items.length} ${result.items.length === 1 ? 'lote en esta página' : 'lotes en esta página'}` : ''}</p>
      </div>
      {error && <Alert tone="danger" role="alert">{error} <Button variant="secondary" onClick={() => { setLoading(true); setRetry(value => value + 1) }}>Reintentar</Button></Alert>}
      {result && <>
        {result.items.length === 0 ? <Card className="explore-empty">
          <h3>No se encontraron lotes con estos filtros.</h3>
          <p>Prueba con otra categoría, amplía el radio o quita los filtros para ver más lotes.</p>
          <Button variant="secondary" onClick={clear}>Ver todos los lotes</Button>
        </Card> : <>
          <p className="explore-results__order">{params.has('latitude') ? 'Más cercanos primero. Las distancias son aproximadas.' : 'Publicaciones más recientes primero.'}</p>
          <div className="explore-list">{result.items.map(lot => <Card as="article" className="explore-lot" key={lot.id}>
            <LotPhoto src={lot.photoUrl} description={`Fotografía del pack: ${lot.description}`} />
            <div className="explore-lot__body">
              <div className="explore-lot__labels"><span className="explore-lot__category">{lot.category}</span>
                <Badge tone={lot.availableQuantity > 0 ? 'success' : 'warning'}>{lot.availableQuantity > 0 ? `${lot.availableQuantity} ${lot.availableQuantity === 1 ? 'pack libre' : 'packs libres'}` : 'Sin stock'}</Badge>
              </div>
              <h3>{lot.description}</h3>
              <dl className="explore-lot__facts">
                <div><dt>Lugar de retiro</dt><dd>{lot.address}{lot.distanceKm !== null && <span className="explore-lot__distance">A {lot.distanceKm} km aprox.</span>}</dd></div>
                <div><dt>Retiro desde</dt><dd><time dateTime={lot.pickupStartsAt}>{formatInstant(lot.pickupStartsAt, lot.timeZone)}</time></dd></div>
                <div><dt>Retiro hasta</dt><dd><time dateTime={lot.pickupEndsAt}>{formatInstant(lot.pickupEndsAt, lot.timeZone)}</time></dd></div>
              </dl>
              <Link className="explore-lot__link" to={{ pathname: `/lotes/${encodeURIComponent(lot.id)}`, search: search ? `?${search}` : '' }}>Ver detalle del lote <span aria-hidden="true">↗</span></Link>
            </div>
          </Card>)}</div>
        </>}
        {(page > 1 || result.hasNextPage) && <nav className="explore-pagination" aria-label="Páginas de resultados">
          {page > 1 && <Link to={pageLink(page - 1)}>Página anterior</Link>}
          <span aria-current="page">Página {result.page}</span>
          {result.hasNextPage && <Link to={pageLink(page + 1)}>Página siguiente</Link>}
        </nav>}
      </>}
    </section>
  </div></main>
}
