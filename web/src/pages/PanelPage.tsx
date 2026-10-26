import './panel.css'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Icon } from '../components/Icon'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input, Select } from '../components/ui/FormControls'
import { FormField } from '../components/ui/FormField'
import { formatInstant, formatWindow } from '../lots/lot-time'
import { lotTitle } from '../lots/lot-title'
import type { OperableEstablishment } from '../services/identity-service'
import {
  getPanel, listActivity, listCommitments, panelError,
  type ActivityEvent, type ActivityPage, type EstablishmentPanel, type OperatorCommitment, type OperatorCommitmentPage, type PanelInventory,
} from '../services/panel-service'

const packs = (quantity: number) => `${quantity} ${quantity === 1 ? 'pack' : 'packs'}`
/** «1 pack retenido», «2 packs retenidos». */
const packsThat = (quantity: number, adjective: string) => `${packs(quantity)} ${adjective}${quantity === 1 ? '' : 's'}`
const percent = new Intl.NumberFormat('es-CL', { style: 'percent', maximumFractionDigits: 1 })
/** Fechas locales del período (YYYY-MM-DD), sin reinterpretarlas en la zona del navegador. */
const formatDate = (date: string) => new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeZone: 'UTC' })
  .format(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))))

/** Q = F + O + R + E + X; el orden sigue el recorrido de un pack (anexos B p. 4). */
const inventoryParts = [
  { key: 'free', label: 'Libres' },
  { key: 'offered', label: 'Ofrecidos' },
  { key: 'reserved', label: 'Reservados' },
  { key: 'delivered', label: 'Retirados' },
  { key: 'unassignable', label: 'No asignables' },
] as const satisfies readonly { key: keyof PanelInventory; label: string }[]

const commitmentLabels: Record<OperatorCommitment['kind'], Partial<Record<OperatorCommitment['status'], { label: string; tone: 'neutral' | 'success' | 'warning' | 'info' | 'danger' }>>> = {
  reservation: {
    confirmed: { label: 'Por retirar', tone: 'success' },
    cancelled: { label: 'Cancelada', tone: 'danger' },
    expired: { label: 'Vencida sin retiro', tone: 'neutral' },
    delivered: { label: 'Retirada', tone: 'info' },
  },
  waitlist: {
    waiting: { label: 'En espera', tone: 'warning' },
    offered: { label: 'Oferta por aceptar', tone: 'warning' },
    accepted: { label: 'Oferta aceptada', tone: 'info' },
    declined: { label: 'Oferta rechazada', tone: 'neutral' },
    expired: { label: 'Vencida', tone: 'neutral' },
    left: { label: 'Salió de la espera', tone: 'neutral' },
  },
}

/** Texto del historial: sin titulares ni códigos, solo el hecho y su cantidad. */
function describeActivity(event: ActivityEvent): string {
  const quantity = packs(event.quantity ?? 0)
  switch (event.kind) {
    case 'lot_published': return `Se publicó el lote con ${quantity}`
    case 'lot_expired': return 'Cerró la ventana de retiro del lote'
    case 'lot_withdrawn': return 'Se retiró el lote'
    case 'reservation_confirmed': return `Una persona reservó ${quantity}`
    case 'offer_accepted': return `Una persona aceptó una oferta de ${quantity}`
    case 'reservation_cancelled': return `Se canceló una reserva de ${quantity}`
    case 'reservation_expired': return `Venció una reserva de ${quantity} sin retiro`
    case 'pickup_confirmed': return `Se acreditó el retiro de ${quantity}`
    case 'waitlist_joined': return `Una persona entró a la espera por ${quantity}`
    case 'offer_issued': return `Se ofrecieron ${quantity} a la primera persona de la espera`
    case 'offer_declined': return `Se rechazó una oferta de ${quantity}`
    case 'offer_expired': return `Venció una oferta de ${quantity} sin aceptar`
    case 'waitlist_left': return 'Una persona salió de la espera'
    case 'waitlist_expired': return 'Una espera terminó con el cierre del lote'
  }
}

function InventoryBar({ inventory, quantity }: { inventory: PanelInventory; quantity: number }) {
  return (
    <div className="inventory">
      {/* La barra es decorativa: la leyenda da los mismos valores como texto. */}
      <div className="inventory__bar" aria-hidden="true">
        {inventoryParts.map(part => inventory[part.key] > 0 && (
          <span key={part.key} className={`inventory__part inventory__part--${part.key}`} style={{ flexGrow: inventory[part.key] }} />
        ))}
      </div>
      <ul className="inventory__legend" aria-label={`Estado de los ${packs(quantity)}`}>
        {inventoryParts.map(part => (
          <li key={part.key}><span className={`inventory__swatch inventory__part--${part.key}`} aria-hidden="true" />{part.label} <strong>{inventory[part.key]}</strong></li>
        ))}
      </ul>
    </div>
  )
}

function Stat({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <Card className="panel-stat">
      <p className="panel-stat__label">{label}</p>
      <p className="panel-stat__value">{value}</p>
      <p className="panel-stat__detail">{detail}</p>
    </Card>
  )
}

function RateCard({ title, rate, numerator, denominator, empty }: {
  title: string; rate: EstablishmentPanel['period']['deliveryRate']; numerator: string; denominator: string; empty: string
}) {
  return (
    <Card className="panel-rate">
      <h3>{title}</h3>
      {rate.value === null
        ? <p className="panel-rate__value panel-rate__value--empty">Sin datos</p>
        : <p className="panel-rate__value">{percent.format(rate.value)}</p>}
      <p className="panel-rate__fraction">{rate.value === null ? empty : `${rate.numerator} ${numerator} de ${rate.denominator} ${denominator}`}</p>
    </Card>
  )
}

type Loaded<T> = { key: string; value: T | null; error: string | null }

/**
 * Carga con cancelación: una respuesta de filtros anteriores no pisa la vigente. `key` cambia
 * con los filtros y con «Actualizar»; `load` debe venir de useCallback.
 */
function useLoad<T>(key: string, load: (signal: AbortSignal) => Promise<T>): { value: T | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<Loaded<T>>({ key: '', value: null, error: null })
  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
      .then(value => { if (!controller.signal.aborted) setState({ key, value, error: null }) })
      .catch(reason => { if (!controller.signal.aborted) setState({ key, value: null, error: panelError(reason) }) })
    return () => controller.abort()
  }, [key, load])
  return { value: state.value, error: state.error, loading: state.key !== key }
}

function Pagination({ label, page, hasNextPage, onChange }: { label: string; page: number; hasNextPage: boolean; onChange: (page: number) => void }) {
  if (page === 1 && !hasNextPage) return null
  return (
    <nav className="panel-pagination" aria-label={label}>
      {page > 1 && <Button variant="secondary" onClick={() => onChange(page - 1)}>Más recientes</Button>}
      <span aria-current="page">Página {page}</span>
      {hasNextPage && <Button variant="secondary" onClick={() => onChange(page + 1)}>Anteriores</Button>}
    </nav>
  )
}

function Commitments({ establishmentId, lotId, state, refresh, timeZone }: {
  establishmentId: string; lotId?: string; state?: 'active' | 'ended'; refresh: number; timeZone: string
}) {
  const [page, setPage] = useState(1)
  const filters = `${establishmentId}:${lotId ?? ''}:${state ?? ''}:${refresh}`
  const [pageFilters, setPageFilters] = useState(filters)
  if (pageFilters !== filters) { setPageFilters(filters); setPage(1) }
  const load = useCallback((signal: AbortSignal) => listCommitments(establishmentId, { lotId, state, page }, signal),
    [establishmentId, lotId, state, page])
  const { value, error, loading } = useLoad<OperatorCommitmentPage>(`${filters}:${page}`, load)
  const empty = state === 'active' ? 'No hay reservas ni solicitudes vigentes.' : state === 'ended' ? 'Aún no hay compromisos terminados.' : 'Aún no hay compromisos.'
  return (
    <div aria-busy={loading}>
      {loading && !value && <p className="panel__status" role="status">Cargando compromisos…</p>}
      {error && <Alert tone="danger" role="alert">{error}</Alert>}
      {value && value.items.length === 0 && <p className="panel__empty">{empty}</p>}
      {value && value.items.length > 0 && (
        <ul className="panel-commitments">
          {value.items.map(item => {
            const badge = commitmentLabels[item.kind][item.status] ?? { label: item.status, tone: 'neutral' as const }
            return (
              <li key={item.id} className="panel-commitment">
                <div className="panel-commitment__head">
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                  <span className="panel-commitment__kind">{item.kind === 'reservation' ? 'Reserva' : 'Solicitud de espera'}</span>
                </div>
                <p className="panel-commitment__quantity">
                  {item.kind === 'reservation' ? packs(item.quantity)
                    : item.offeredQuantity === null ? `Pide ${packs(item.quantity)}` : `Pide ${packs(item.quantity)} · ofrecidos ${item.offeredQuantity}`}
                </p>
                <p className="panel-commitment__lot">{lotTitle(item.lot.description)}</p>
                <p className="panel-commitment__time">
                  Desde {formatInstant(item.createdAt, timeZone)}
                  {item.endedAt && ` · terminó ${formatInstant(item.endedAt, timeZone)}`}
                  {item.status === 'offered' && item.offerExpiresAt && ` · vence ${formatInstant(item.offerExpiresAt, timeZone)}`}
                </p>
              </li>
            )
          })}
        </ul>
      )}
      {value && <Pagination label="Páginas de compromisos" page={value.page} hasNextPage={value.hasNextPage} onChange={setPage} />}
    </div>
  )
}

function Activity({ establishmentId, lotId, refresh, timeZone, onSelectLot }: {
  establishmentId: string; lotId?: string; refresh: number; timeZone: string; onSelectLot: (id: string, description: string) => void
}) {
  const [page, setPage] = useState(1)
  const filters = `${establishmentId}:${lotId ?? ''}:${refresh}`
  const [pageFilters, setPageFilters] = useState(filters)
  if (pageFilters !== filters) { setPageFilters(filters); setPage(1) }
  const load = useCallback((signal: AbortSignal) => listActivity(establishmentId, { lotId, page }, signal),
    [establishmentId, lotId, page])
  const { value, error, loading } = useLoad<ActivityPage>(`${filters}:${page}`, load)
  return (
    <div aria-busy={loading}>
      {loading && !value && <p className="panel__status" role="status">Cargando historial…</p>}
      {error && <Alert tone="danger" role="alert">{error}</Alert>}
      {value && value.items.length === 0 && <p className="panel__empty">Aún no hay actividad.</p>}
      {value && value.items.length > 0 && (
        <ol className="panel-activity">
          {value.items.map(event => (
            <li key={event.id} className={`panel-activity__item panel-activity__item--${event.kind}`}>
              <p>{describeActivity(event)}</p>
              <p className="panel-activity__meta">
                <time dateTime={event.at}>{formatInstant(event.at, timeZone)}</time>
                {lotId === undefined && <> · <button type="button" className="panel-activity__lot" onClick={() => onSelectLot(event.lot.id, event.lot.description)}>{lotTitle(event.lot.description)}</button></>}
              </p>
            </li>
          ))}
        </ol>
      )}
      {value && <Pagination label="Páginas del historial" page={value.page} hasNextPage={value.hasNextPage} onChange={setPage} />}
    </div>
  )
}

function PeriodForm({ from, to, onApply }: { from: string; to: string; onApply: (from: string, to: string) => void }) {
  const [draft, setDraft] = useState({ from, to })
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState(`${from}:${to}`)
  if (applied !== `${from}:${to}`) { setApplied(`${from}:${to}`); setDraft({ from, to }); setError(null) }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!draft.from || !draft.to) { setError('Indica ambas fechas.'); return }
    if (draft.from > draft.to) { setError('La fecha inicial no puede ser posterior a la final.'); return }
    setError(null)
    onApply(draft.from, draft.to)
  }
  return (
    <form className="panel-period__form" onSubmit={submit} noValidate>
      <FormField label="Desde" error={error ?? undefined}>{control => (
        <Input {...control} type="date" value={draft.from} max={draft.to || undefined} onChange={event => setDraft(value => ({ ...value, from: event.target.value }))} />
      )}</FormField>
      <FormField label="Hasta">{control => (
        <Input {...control} type="date" value={draft.to} min={draft.from || undefined} onChange={event => setDraft(value => ({ ...value, to: event.target.value }))} />
      )}</FormField>
      <Button type="submit" variant="secondary">Ver período</Button>
    </form>
  )
}

function Panel({ establishments }: { establishments: OperableEstablishment[] }) {
  const [params, setParams] = useSearchParams()
  const establishment = establishments.find(item => item.id === params.get('establecimiento')) ?? establishments[0]!
  const from = params.get('desde') ?? undefined
  const to = params.get('hasta') ?? undefined
  const lotId = params.get('lote') ?? undefined
  const stateParam = params.get('estado')
  const state = stateParam === 'terminados' ? 'ended' : stateParam === 'todos' ? undefined : 'active'
  const [refresh, setRefresh] = useState(0)
  // Nombre del lote filtrado cuando no está entre los abiertos (por ejemplo, elegido desde el historial).
  const [selectedLot, setSelectedLot] = useState<{ id: string; description: string } | null>(null)
  const loadPanel = useCallback((signal: AbortSignal) => getPanel(establishment.id, { from, to }, signal), [establishment.id, from, to])
  const panel = useLoad<EstablishmentPanel>(`${establishment.id}:${from ?? ''}:${to ?? ''}:${refresh}`, loadPanel)

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key)
    setParams(next)
  }
  const data = panel.value
  const timeZone = data?.establishment.timeZone ?? 'America/Santiago'
  const openLots = data?.current.lots ?? []
  const lotOptions = [...openLots.map(lot => ({ id: lot.id, description: lot.description })),
    ...(lotId && !openLots.some(lot => lot.id === lotId) ? [{ id: lotId, description: selectedLot?.id === lotId ? selectedLot.description : 'Lote seleccionado' }] : [])]
  const stateTabs = [{ value: null, label: 'Vigentes' }, { value: 'terminados', label: 'Terminados' }, { value: 'todos', label: 'Todos' }]

  return (
    <div className="panel">
      <header className="page-header">
        <div>
          <p className="eyebrow">Operación</p>
          <h1>Mi establecimiento</h1>
          <p>Lo que pasa hoy con tus lotes, quién espera y cómo terminaron los lotes que cerraron.</p>
        </div>
        <Link className="ui-button ui-button--primary" to="/operador/lotes/nuevo"><Icon name="plus" />Publicar lote</Link>
      </header>
      <div className="my-lots__toolbar">
        {establishments.length > 1
          ? <FormField label="Establecimiento">{control => (
            <Select {...control} value={establishment.id} onChange={event => update({ establecimiento: event.target.value, lote: null })}>
              {establishments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          )}</FormField>
          : <p className="my-lots__establishment"><Icon name="pin" />{establishment.name}</p>}
        <div className="panel__refresh">
          {data && <p className="panel__as-of" role="status">Actualizado {formatInstant(data.asOf, timeZone)}</p>}
          <Button variant="secondary" loading={panel.loading && data !== null} onClick={() => setRefresh(value => value + 1)}>Actualizar</Button>
        </div>
      </div>

      {panel.error && <Alert tone="danger" role="alert">{panel.error} <Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Reintentar</Button></Alert>}
      {panel.loading && !data && !panel.error && <p className="panel__status" role="status">Cargando el panel…</p>}

      {data && (
        <>
          <section className="panel__section" aria-labelledby="panel-now">
            <h2 id="panel-now">Ahora</h2>
            <div className="panel-stats">
              <Stat label="Lotes abiertos" value={openLots.length} detail={packsThat(data.current.inventory.free, 'libre')} />
              <Stat label="Reservas por retirar" value={data.current.confirmedReservations} detail={packsThat(data.current.inventory.reserved, 'reservado')} />
              <Stat label="Ofertas por aceptar" value={data.current.activeOffers} detail={packsThat(data.current.inventory.offered, 'retenido')} />
              <Stat label="Personas en espera" value={data.current.waitingRequests} detail="Sin packs asignados" />
            </div>
            {openLots.length === 0
              ? <Card className="empty-state">
                <span className="empty-state__icon"><Icon name="box" /></span>
                <h3>No tienes lotes abiertos</h3>
                <p>Los lotes publicados aparecen aquí mientras su ventana de retiro siga abierta.</p>
              </Card>
              : <ul className="panel-lots">
                {openLots.map(lot => (
                  <li key={lot.id}>
                    <Card as="article" className="panel-lot">
                      <div className="panel-lot__head">
                        <h3><Link to={`/operador/lotes/${encodeURIComponent(lot.id)}`}>{lotTitle(lot.description)}</Link></h3>
                        <p className="panel-lot__quantity">{packs(lot.quantity)}</p>
                      </div>
                      <p className="panel-lot__window"><Icon name="clock" />{formatWindow(lot.pickupStartsAt, lot.pickupEndsAt, timeZone)}</p>
                      <InventoryBar inventory={lot.inventory} quantity={lot.quantity} />
                      <p className="panel-lot__queue">
                        {lot.waitingRequests === 0 ? 'Nadie en espera' : `${lot.waitingRequests} ${lot.waitingRequests === 1 ? 'persona en espera' : 'personas en espera'}`}
                        {lot.activeOffers > 0 && ` · ${lot.activeOffers} ${lot.activeOffers === 1 ? 'oferta por aceptar' : 'ofertas por aceptar'}`}
                      </p>
                      <div className="panel-lot__actions">
                        <Button variant="secondary" aria-pressed={lotId === lot.id}
                          onClick={() => update({ lote: lotId === lot.id ? null : lot.id })}>{lotId === lot.id ? 'Ver todos los lotes' : 'Ver compromisos'}</Button>
                        <Link className="ui-button ui-button--secondary" to={`/operador/lotes/${encodeURIComponent(lot.id)}/retiros`}>Validar retiros</Link>
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>}
          </section>

          <section className="panel__section" aria-labelledby="panel-period">
            <div className="panel__section-head">
              <h2 id="panel-period">Resultados del período</h2>
              <PeriodForm from={data.period.from} to={data.period.to} onApply={(nextFrom, nextTo) => update({ desde: nextFrom, hasta: nextTo })} />
            </div>
            <p className="panel-period__scope">
              Lotes cerrados entre el {formatDate(data.period.from)} y el {formatDate(data.period.to)}: <strong>{data.period.closedLots}</strong>.
              {' '}Fechas en la zona {timeZone}.
            </p>
            <div className="panel-rates">
              <RateCard title="Packs retirados" rate={data.period.deliveryRate} numerator="retirados" denominator="publicados"
                empty="Ningún lote cerró en el período." />
              <RateCard title="Reservas vencidas" rate={data.period.reservationExpiryRate} numerator="vencidas" denominator="confirmadas"
                empty="Ninguna reserva en lotes cerrados del período." />
            </div>
            <div className="panel-counts">
              <dl>
                <div><dt>Packs publicados</dt><dd>{data.period.packs.published}</dd></div>
                <div><dt>Retirados</dt><dd>{data.period.packs.delivered}</dd></div>
                <div><dt>No asignables</dt><dd>{data.period.packs.unassignable}</dd></div>
              </dl>
              <dl>
                <div><dt>Reservas confirmadas</dt><dd>{data.period.reservations.confirmed}</dd></div>
                <div><dt>Retiradas</dt><dd>{data.period.reservations.delivered}</dd></div>
                <div><dt>Canceladas</dt><dd>{data.period.reservations.cancelled}</dd></div>
                <div><dt>Vencidas</dt><dd>{data.period.reservations.expired}</dd></div>
              </dl>
            </div>
            <p className="panel-period__exclusions">
              <Icon name="info" />
              <span>
                No incluye {data.period.excluded.openLots === 1 ? '1 lote abierto' : `${data.period.excluded.openLots} lotes abiertos`} ni
                {' '}{data.period.excluded.draftLots === 1 ? '1 borrador' : `${data.period.excluded.draftLots} borradores`}.
                {' '}La espera y las ofertas no aceptadas no son reservas. Retirado es una entrega acreditada por el operador, no consumo.
              </span>
            </p>
          </section>

          <div className="panel__columns">
            <section className="panel__section" aria-labelledby="panel-commitments">
              <div className="panel__section-head">
                <h2 id="panel-commitments">Compromisos</h2>
                <nav className="segmented" aria-label="Filtrar compromisos">
                  {stateTabs.map(tab => (
                    <Link key={tab.label} className="segmented__item" aria-current={(stateParam ?? null) === tab.value || (tab.value === null && !['terminados', 'todos'].includes(stateParam ?? '')) ? 'page' : undefined}
                      to={{ search: (() => { const next = new URLSearchParams(params); if (tab.value) next.set('estado', tab.value); else next.delete('estado'); return `?${next}` })() }}>
                      {tab.label}
                    </Link>
                  ))}
                </nav>
              </div>
              <FormField label="Lote">{control => (
                <Select {...control} value={lotId ?? ''} onChange={event => update({ lote: event.target.value || null })}>
                  <option value="">Todos los lotes</option>
                  {lotOptions.map(lot => <option key={lot.id} value={lot.id}>{lotTitle(lot.description)}</option>)}
                </Select>
              )}</FormField>
              <Commitments establishmentId={establishment.id} lotId={lotId} state={state} refresh={refresh} timeZone={timeZone} />
            </section>
            <section className="panel__section" aria-labelledby="panel-activity">
              <h2 id="panel-activity">Historial</h2>
              <Activity establishmentId={establishment.id} lotId={lotId} refresh={refresh} timeZone={timeZone}
                onSelectLot={(id, description) => { setSelectedLot({ id, description }); update({ lote: id }) }} />
            </section>
          </div>
        </>
      )}
    </div>
  )
}

export function PanelPage() {
  const { status, session } = useAuth()
  const { pathname } = useLocation()
  if (status === 'checking' || status === 'error') {
    return <main className="page-content"><div className="panel"><p className="panel__status" role="status">Comprobando la sesión…</p></div></main>
  }
  if (!session) {
    return <main className="page-content"><Card as="section" className="content-card lot-card" aria-labelledby="panel-title">
      <p className="eyebrow">Operación</p><h1 id="panel-title">Mi establecimiento</h1>
      <p>Inicia sesión con una cuenta habilitada por un establecimiento para ver su panel.</p>
      <Link className="text-link" to={`/login?from=${encodeURIComponent(pathname)}`}>Iniciar sesión</Link>
    </Card></main>
  }
  if (session.operableEstablishments.length === 0) {
    return <main className="page-content"><Card as="section" className="content-card lot-card" aria-labelledby="panel-title">
      <p className="eyebrow">Operación</p><h1 id="panel-title">Mi establecimiento</h1>
      <p>Tu cuenta todavía no está habilitada para operar un establecimiento. La habilitación se gestiona por separado.</p>
    </Card></main>
  }
  return <main className="page-content"><Panel establishments={session.operableEstablishments} /></main>
}
