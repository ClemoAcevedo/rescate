import { HttpError, UnexpectedResponseError, request } from './http-client'
import type { ActivityEvent, ActivityPage, EstablishmentPanel, OperatorCommitment, OperatorCommitmentPage, PanelInventory, PanelOpenLot } from './openapi'

export type { ActivityEvent, ActivityPage, EstablishmentPanel, OperatorCommitment, OperatorCommitmentPage, PanelInventory, PanelOpenLot }
type Rate = EstablishmentPanel['period']['deliveryRate']

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const nullableInstant = (value: unknown) => value === null || instant(value)
const localDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const counts = <K extends string>(value: unknown, keys: readonly K[]): Record<K, number> => {
  if (!record(value) || !keys.every(key => count(value[key]))) throw new Error('Conteos inesperados.')
  return Object.fromEntries(keys.map(key => [key, value[key]])) as Record<K, number>
}
const inventoryKeys = ['free', 'offered', 'reserved', 'delivered', 'unassignable'] as const
const commitmentStatuses = ['confirmed', 'cancelled', 'expired', 'delivered', 'waiting', 'offered', 'accepted', 'declined', 'left']
const activityKinds = ['lot_published', 'lot_expired', 'lot_withdrawn', 'reservation_confirmed', 'reservation_cancelled',
  'reservation_expired', 'pickup_confirmed', 'waitlist_joined', 'offer_issued', 'offer_accepted', 'offer_declined',
  'offer_expired', 'waitlist_left', 'waitlist_expired']

function lotRef(value: unknown) {
  if (!record(value) || !text(value.id) || !text(value.description)) throw new Error('Lote inesperado.')
  return { id: value.id, description: value.description }
}

function rate(value: unknown): Rate {
  const { numerator, denominator } = counts(value, ['numerator', 'denominator'] as const)
  const ratio = (value as Record<string, unknown>).value
  // El indicador debe ser exactamente numerador sobre denominador, o null sin denominador.
  if (denominator === 0 ? ratio !== null : typeof ratio !== 'number' || Math.abs(ratio - numerator / denominator) > 1e-9) {
    throw new Error('Indicador incoherente.')
  }
  return { numerator, denominator, value: ratio as number | null }
}

function openLot(value: unknown): PanelOpenLot {
  if (!record(value) || !text(value.id) || !text(value.description) || !count(value.quantity)
    || !instant(value.pickupStartsAt) || !instant(value.pickupEndsAt)) throw new Error('Lote abierto inesperado.')
  const inventory = counts(value.inventory, inventoryKeys)
  if (inventoryKeys.reduce((total, key) => total + inventory[key], 0) !== value.quantity) throw new Error('Inventario que no cuadra.')
  return { id: value.id, description: value.description, quantity: value.quantity, pickupStartsAt: value.pickupStartsAt,
    pickupEndsAt: value.pickupEndsAt, inventory, ...counts(value, ['confirmedReservations', 'activeOffers', 'waitingRequests'] as const) }
}

function panel(value: unknown): EstablishmentPanel {
  if (!record(value) || !record(value.establishment) || !text(value.establishment.id) || !text(value.establishment.name)
    || !text(value.establishment.timeZone) || !instant(value.asOf) || !record(value.current) || !Array.isArray(value.current.lots)
    || !record(value.period) || !localDate(value.period.from) || !localDate(value.period.to)) throw new Error('Panel inesperado.')
  const { current, period } = value
  return {
    establishment: { id: value.establishment.id, name: value.establishment.name, timeZone: value.establishment.timeZone },
    asOf: value.asOf,
    current: { lots: (current.lots as unknown[]).map(openLot), inventory: counts(current.inventory, inventoryKeys),
      ...counts(current, ['confirmedReservations', 'activeOffers', 'waitingRequests'] as const) },
    period: {
      from: period.from as string, to: period.to as string, closedLots: counts(period, ['closedLots'] as const).closedLots,
      packs: counts(period.packs, ['published', 'delivered', 'unassignable'] as const),
      reservations: counts(period.reservations, ['confirmed', 'cancelled', 'expired', 'delivered'] as const),
      deliveryRate: rate(period.deliveryRate), reservationExpiryRate: rate(period.reservationExpiryRate),
      excluded: counts(period.excluded, ['openLots', 'draftLots'] as const),
    },
  }
}

function commitment(value: unknown): OperatorCommitment {
  if (!record(value) || !text(value.id) || !['reservation', 'waitlist'].includes(String(value.kind))
    || !commitmentStatuses.includes(String(value.status)) || !Number.isSafeInteger(value.quantity) || (value.quantity as number) < 1
    || !(value.offeredQuantity === null || count(value.offeredQuantity)) || !nullableInstant(value.offerExpiresAt)
    || !instant(value.createdAt) || !nullableInstant(value.endedAt)) throw new Error('Compromiso inesperado.')
  // Selección explícita: solo los campos del contrato llegan a la vista.
  return { id: value.id, kind: value.kind as OperatorCommitment['kind'], status: value.status as OperatorCommitment['status'],
    lot: lotRef(value.lot), quantity: value.quantity as number, offeredQuantity: value.offeredQuantity as number | null,
    offerExpiresAt: value.offerExpiresAt as string | null, createdAt: value.createdAt, endedAt: value.endedAt as string | null }
}

function activity(value: unknown): ActivityEvent {
  if (!record(value) || !text(value.id) || !activityKinds.includes(String(value.kind)) || !instant(value.at)
    || !(value.quantity === null || count(value.quantity))) throw new Error('Hecho inesperado.')
  return { id: value.id, kind: value.kind as ActivityEvent['kind'], at: value.at, lot: lotRef(value.lot), quantity: value.quantity as number | null }
}

function page<T>(value: unknown, requested: number, item: (value: unknown) => T) {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 20 || value.page !== requested
    || typeof value.hasNextPage !== 'boolean') throw new Error('Página inesperada.')
  return { items: value.items.map(item), page: requested, hasNextPage: value.hasNextPage }
}

async function get<T>(path: string, parse: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
  const result = await request({ path, parse, signal })
  if (result === undefined) throw new UnexpectedResponseError('Respuesta vacía.', undefined)
  return result
}

const base = (establishmentId: string) => `/establishments/${encodeURIComponent(establishmentId)}`
const search = (values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value))
  const query = params.toString()
  return query ? `?${query}` : ''
}

export function getPanel(establishmentId: string, period: { from?: string; to?: string }, signal?: AbortSignal): Promise<EstablishmentPanel> {
  return get(`${base(establishmentId)}/panel${search(period)}`, panel, signal)
}

export function listCommitments(establishmentId: string, query: { lotId?: string; state?: 'active' | 'ended'; page: number },
  signal?: AbortSignal): Promise<OperatorCommitmentPage> {
  return get(`${base(establishmentId)}/commitments${search({ ...query, page: query.page > 1 ? query.page : undefined })}`,
    value => page(value, query.page, commitment), signal)
}

export function listActivity(establishmentId: string, query: { lotId?: string; page: number }, signal?: AbortSignal): Promise<ActivityPage> {
  return get(`${base(establishmentId)}/activity${search({ ...query, page: query.page > 1 ? query.page : undefined })}`,
    value => page(value, query.page, activity), signal)
}

export function panelError(error: unknown): string {
  if (error instanceof HttpError && error.status === 401) return 'Tu sesión venció. Inicia sesión nuevamente.'
  if (error instanceof HttpError && error.status === 403) return 'Tu cuenta ya no está habilitada para este establecimiento.'
  if (error instanceof HttpError && error.status === 404) return 'El establecimiento o el lote no existe.'
  if (error instanceof HttpError && error.status === 422) return 'Revisa el período: la fecha inicial no puede ser posterior a la final y el máximo es un año.'
  if (error instanceof HttpError && error.status === 429) return 'Hay demasiadas solicitudes. Espera antes de reintentar.'
  return 'No fue posible cargar el panel. Revisa tu conexión e inténtalo nuevamente.'
}
