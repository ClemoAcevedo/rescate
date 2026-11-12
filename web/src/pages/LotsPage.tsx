import { DEFAULT_TIME_ZONE } from '../format/date-time'
import { instantToLocalInput, localInputToInstant } from '../lots/lot-time'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { LotsSkeleton } from '../components/lots/LotSkeletons'
import { LotCard } from '../components/lots/LotCard'
import { Alert } from '../components/ui/Alert'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input, Select } from '../components/ui/FormControls'
import { FormField } from '../components/ui/FormField'
import { discoveryError, searchPublicLots, type PublicLotPage } from '../services/discovery-service'

// La categoría es texto libre en el contrato, así que solo se sugieren las más comunes
const categorySuggestions = ['Panadería', 'Pastelería', 'Frutas y verduras', 'Almacén', 'Comida preparada', 'Lácteos']
const radiusOptions = ['2', '5', '10', '25']

type Filters = { category: string; latitude: string; longitude: string; radiusKm: string; pickupBefore: string }
const emptyFilters: Filters = { category: '', latitude: '', longitude: '', radiusKm: '', pickupBefore: '' }
function fromParams(params: URLSearchParams): Filters {
  const before = params.get('pickupBefore')
  const beforeDate = before && Number.isFinite(Date.parse(before)) ? new Date(before) : null
  return { category: params.get('category') ?? '', latitude: params.get('latitude') ?? '',
    longitude: params.get('longitude') ?? '', radiusKm: params.get('radiusKm') ?? '',
    pickupBefore: beforeDate ? instantToLocalInput(before!, DEFAULT_TIME_ZONE) : '' }
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
  const [locationOpen, setLocationOpen] = useState(false)
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
      setLocationOpen(true)
      setFilterError('Completa latitud y longitud para buscar por zona, o deja ambas vacías.'); return
    }
    if (filters.radiusKm.trim() && !filters.latitude.trim()) {
      setFilterError('Usa tu ubicación o ingresa coordenadas para buscar por distancia.'); return
    }
    if (filters.pickupBefore && !localInputToInstant(filters.pickupBefore, DEFAULT_TIME_ZONE)) {
      setFilterError('Ingresa una fecha y hora de retiro válidas.'); return
    }
    setFilterError(null)
    const next = new URLSearchParams()
    if (filters.category.trim()) next.set('category', filters.category.trim())
    if (filters.latitude.trim() && filters.longitude.trim()) {
      next.set('latitude', filters.latitude.trim()); next.set('longitude', filters.longitude.trim())
      if (filters.radiusKm.trim()) next.set('radiusKm', filters.radiusKm.trim())
    }
    if (filters.pickupBefore) next.set('pickupBefore', localInputToInstant(filters.pickupBefore, DEFAULT_TIME_ZONE)!)
    setLoading(true); setError(null); setResult(null); setParams(next); setRetry(value => value + 1)
  }
  const locate = () => {
    if (!navigator.geolocation) { setLocationMessage('Tu navegador no permite usar tu ubicación. Puedes ingresar coordenadas.'); setLocationOpen(true); return }
    setLocating(true); setLocationMessage(null)
    navigator.geolocation.getCurrentPosition(position => {
      setFilters(current => ({ ...current, latitude: String(position.coords.latitude.toFixed(5)),
        longitude: String(position.coords.longitude.toFixed(5)), radiusKm: current.radiusKm || '10' }))
      setLocationMessage('Ubicación lista. Pulsa Buscar lotes para ver los más cercanos.')
      setLocating(false)
    }, () => { setLocationMessage('No se obtuvo tu ubicación. Puedes buscar sin ella o ingresar coordenadas.'); setLocating(false) },
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
  // Un radio que llegó por URL y no está en la lista se conserva como opción
  const radii = filters.radiusKm && !radiusOptions.includes(filters.radiusKm) ? [...radiusOptions, filters.radiusKm] : radiusOptions
  return <main className="page-content"><div className="explore-page">
    <header className="explore-hero">
      <div className="explore-hero__text">
        <p className="eyebrow">Alimentos que no se pierden</p>
        <h1>Encuentra packs para rescatar cerca de ti</h1>
        <p>Panaderías, almacenes y restaurantes publican sus excedentes del día. Reserva tus packs y retíralos en el horario indicado.</p>
      </div>
      <ol className="explore-hero__steps" aria-label="Cómo funciona">
        <li><span className="explore-hero__step-icon"><Icon name="pin" /></span><span><strong>Busca</strong> lotes por zona o categoría</span></li>
        <li><span className="explore-hero__step-icon"><Icon name="box" /></span><span><strong>Reserva</strong> los packs que vas a retirar</span></li>
        <li><span className="explore-hero__step-icon"><Icon name="clock" /></span><span><strong>Retira</strong> dentro de la ventana del local</span></li>
      </ol>
    </header>
    <Card as="section" className="explore-filters" aria-label="Filtros de búsqueda">
      <form className="explore-filters__form" onSubmit={submit}>
        <div className="explore-filters__main">
          <FormField label="Categoría">{control => <Input {...control} list="explore-categories" maxLength={100} value={filters.category} onChange={event => change('category', event.target.value)} placeholder="Todas" />}</FormField>
          <datalist id="explore-categories">{categorySuggestions.map(category => <option key={category} value={category} />)}</datalist>
          <FormField label="Retiro comienza antes de">{control => <Input {...control} type="datetime-local" value={filters.pickupBefore} onChange={event => change('pickupBefore', event.target.value)} />}</FormField>
          <Button type="submit" loading={loading}>{loading ? 'Buscando…' : 'Buscar lotes'}</Button>
          <p className="explore-filters__note">Horarios en {DEFAULT_TIME_ZONE}.</p>
        </div>
        <div className="explore-filters__location">
          <FormField label="Distancia (opcional)">{control => <Select {...control} value={filters.radiusKm} onChange={event => change('radiusKm', event.target.value)}>
            <option value="">Cualquier distancia</option>
            {radii.map(radius => <option key={radius} value={radius}>Hasta {radius} km</option>)}
          </Select>}</FormField>
          <Button variant="secondary" loading={locating} onClick={locate}><Icon name="pin" />{locating ? 'Buscando ubicación…' : 'Usar mi ubicación'}</Button>
        </div>
        <details className="explore-zone" open={locationOpen} onToggle={event => setLocationOpen(event.currentTarget.open)} onInvalidCapture={event => { event.currentTarget.open = true }}>
          <summary>Ingresar coordenadas</summary>
          <div className="explore-filters__fields">
            <FormField label="Latitud de la zona" hint="Ejemplo: -33.45">{control => <Input {...control} type="number" step="any" min={-90} max={90} value={filters.latitude} onChange={event => change('latitude', event.target.value)} />}</FormField>
            <FormField label="Longitud de la zona" hint="Ejemplo: -70.66">{control => <Input {...control} type="number" step="any" min={-180} max={180} value={filters.longitude} onChange={event => change('longitude', event.target.value)} />}</FormField>
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
      {loading && !result && <LotsSkeleton />}
      {result && <>
        {result.items.length === 0 ? <Card className="explore-empty">
          <h3>No se encontraron lotes con estos filtros.</h3>
          <p>Prueba con otra categoría, amplía el radio o quita los filtros para ver más lotes.</p>
          <Button variant="secondary" onClick={clear}>Ver todos los lotes</Button>
        </Card> : <>
          <p className="explore-results__order">{params.has('latitude') ? 'Más cercanos primero. Las distancias son aproximadas.' : 'Publicaciones más recientes primero.'}</p>
          <div className="explore-list">{result.items.map(lot => <LotCard key={lot.id} lot={lot}
            to={{ pathname: `/lotes/${encodeURIComponent(lot.id)}`, search: search ? `?${search}` : '' }} />)}</div>
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
