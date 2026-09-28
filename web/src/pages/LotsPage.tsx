import { useEffect, useState, type FormEvent } from 'react'
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
  const [params, setParams] = useSearchParams()
  const [filters, setFilters] = useState<Filters>(() => fromParams(params))
  const [result, setResult] = useState<PublicLotPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filterError, setFilterError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [locationMessage, setLocationMessage] = useState<string | null>(null)
  const [locating, setLocating] = useState(false)
  const search = params.toString()

  useEffect(() => {
    const controller = new AbortController()
    searchPublicLots(search ? `?${search}` : '', controller.signal)
      .then(page => { if (!controller.signal.aborted) { setResult(page); setError(null) } })
      .catch(reason => { if (!controller.signal.aborted) { setResult(null); setError(discoveryError(reason)) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [search, retry])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (Boolean(filters.latitude.trim()) !== Boolean(filters.longitude.trim())) {
      setFilterError('Completa latitud y longitud para buscar por zona, o deja ambas vacías.'); return
    }
    if (filters.radiusKm.trim() && !filters.latitude.trim()) {
      setFilterError('Ingresa una zona para aplicar el radio.'); return
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
    setLocating(true); setLocationMessage(null)
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
  return <main className="page-content"><div className="explore-page">
    <div className="explore-header"><p className="eyebrow">Explorar</p><h1>Encuentra packs para rescatar</h1>
      <p>Consulta lotes disponibles sin iniciar sesión. Elige una zona a mano o usa tu ubicación si quieres buscar cerca.</p></div>
    <Card as="section" className="explore-filters" aria-label="Filtros de búsqueda">
      <form className="explore-filters__form" onSubmit={submit}>
        <div className="explore-filters__fields">
          <FormField label="Categoría">{control => <Input {...control} value={filters.category} onChange={event => change('category', event.target.value)} placeholder="Ej. Panadería" />}</FormField>
          <FormField label="Latitud de la zona" hint="Puedes ingresarla a mano; por ejemplo, -33.45.">{control => <Input {...control} type="number" step="any" min={-90} max={90} value={filters.latitude} onChange={event => change('latitude', event.target.value)} />}</FormField>
          <FormField label="Longitud de la zona" hint="Por ejemplo, -70.66. Completa ambas coordenadas.">{control => <Input {...control} type="number" step="any" min={-180} max={180} value={filters.longitude} onChange={event => change('longitude', event.target.value)} />}</FormField>
          <FormField label="Radio (km)">{control => <Input {...control} type="number" step="any" min="0.1" max="100" value={filters.radiusKm} onChange={event => change('radiusKm', event.target.value)} />}</FormField>
          <FormField label="Retiro comienza antes de">{control => <Input {...control} type="datetime-local" value={filters.pickupBefore} onChange={event => change('pickupBefore', event.target.value)} />}</FormField>
        </div>
        <div className="explore-filters__actions"><Button type="submit">Buscar lotes</Button>
          <Button variant="secondary" loading={locating} onClick={locate}>Usar mi ubicación</Button>
          <Button variant="ghost" onClick={() => { setFilters(emptyFilters); setFilterError(null); setLoading(true); setParams(new URLSearchParams()); setRetry(value => value + 1) }}>Limpiar filtros</Button></div>
        {filterError && <Alert tone="danger" role="alert">{filterError}</Alert>}
        {locationMessage && <Alert role="status">{locationMessage}</Alert>}
      </form>
    </Card>
    {loading && <Alert role="status">Buscando lotes…</Alert>}
    {error && <Alert tone="danger" role="alert">{error} <Button variant="secondary" onClick={() => { setLoading(true); setRetry(value => value + 1) }}>Reintentar</Button></Alert>}
    {result && <>
      <p role="status">{result.items.length ? `Página ${result.page} · ${result.items.length} lotes` : 'No se encontraron lotes con estos filtros.'}</p>
      <div className="explore-list">{result.items.map(lot => <Card as="article" className="explore-lot" key={lot.id}>
        <LotPhoto src={lot.photoUrl} description={`Fotografía del pack: ${lot.description}`} />
        <Badge tone={lot.availableQuantity > 0 ? 'success' : 'warning'}>{lot.availableQuantity > 0 ? `${lot.availableQuantity} ${lot.availableQuantity === 1 ? 'pack libre' : 'packs libres'}` : 'Sin stock'}</Badge>
        <h2>{lot.description}</h2><p className="explore-lot__meta">{lot.category} · {lot.address}</p>
        <p className="explore-lot__meta">Retiro hasta {formatInstant(lot.pickupEndsAt, lot.timeZone)}{lot.distanceKm !== null ? ` · ${lot.distanceKm} km aprox.` : ''}</p>
        <div className="explore-lot__footer"><Link to={{ pathname: `/lotes/${encodeURIComponent(lot.id)}`, search: search ? `?${search}` : '' }}>Ver detalle del lote</Link></div>
      </Card>)}</div>
      <nav className="explore-pagination" aria-label="Páginas de resultados">
        {page > 1 && <Link to={pageLink(page - 1)}>Página anterior</Link>}
        {result.hasNextPage && <Link to={pageLink(page + 1)}>Página siguiente</Link>}
      </nav>
    </>}
  </div></main>
}
