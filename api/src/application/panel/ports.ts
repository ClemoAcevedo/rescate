// K035 · Application: límites hacia Infrastructure para el panel del establecimiento.
// No exponen pg ni SQL. Los identificadores internos viajan como texto.

import type { Period } from "../../domain/panel.js"
import type { ReservationStatus } from "../../domain/reservations.js"
import type { WaitlistStatus } from "../../domain/waitlist.js"

export interface PanelEstablishment {
  /** Clave interna para autorizar y filtrar; nunca sale por HTTP. */
  id: string
  publicId: string
  name: string
  timeZone: string
}

/** Q = F + O + R + E + X (anexos B p. 4), vigente al consultar. */
export interface Inventory {
  free: number
  offered: number
  reserved: number
  delivered: number
  unassignable: number
}

/** Lote publicado cuya ventana sigue abierta, con su inventario y su espera. */
export interface OpenLot {
  publicId: string
  description: string
  quantity: number
  pickupStartsAt: Date
  pickupEndsAt: Date
  inventory: Inventory
  confirmedReservations: number
  activeOffers: number
  waitingRequests: number
}

/** Conteos de los lotes cerrados dentro del período y de los lotes que quedan fuera. */
export interface PeriodCounts {
  closedLots: number
  publishedPacks: number
  deliveredPacks: number
  unassignablePacks: number
  reservations: { confirmed: number; cancelled: number; expired: number; delivered: number }
  excluded: { openLots: number; draftLots: number }
}

export interface LotRef { id: string; description: string }

/** Compromiso visto por el operador: sin titular ni código de retiro. */
export interface OperatorCommitment {
  publicId: string
  kind: "reservation" | "waitlist"
  lot: LotRef
  /** Estado guardado; Application lo ajusta al vigente con el reloj. */
  status: ReservationStatus | WaitlistStatus
  /** Packs reservados o, en la espera, solicitados. */
  quantity: number
  offeredQuantity: number | null
  offerExpiresAt: Date | null
  createdAt: Date
  endedAt: Date | null
  pickupEndsAt: Date
}

export const ACTIVITY_KINDS = [
  "lot_published", "lot_expired", "lot_withdrawn",
  "reservation_confirmed", "reservation_cancelled", "reservation_expired", "pickup_confirmed",
  "waitlist_joined", "offer_issued", "offer_accepted", "offer_declined", "offer_expired",
  "waitlist_left", "waitlist_expired",
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

/** Hecho del historial; un vencimiento sin registrar ya cuenta desde su plazo (RF08). */
export interface ActivityEvent {
  id: string
  kind: ActivityKind
  at: Date
  lot: LotRef
  quantity: number | null
}

export interface PageFilter {
  /** ID interno del lote, ya comprobado contra el establecimiento. */
  lotId?: string
  page: number
}

export interface CommitmentFilter extends PageFilter {
  /** true: espera, oferta o reserva vigentes; false: terminados; ausente: todos. */
  active?: boolean
}

export interface Page<T> { items: T[]; hasNextPage: boolean }

export interface PanelRepository {
  findEstablishment(publicId: string): Promise<PanelEstablishment | null>
  isMemberOfEstablishment(userId: string, establishmentId: string): Promise<boolean>
  /** ID interno del lote si pertenece al establecimiento; si no, `null`. */
  findLot(establishmentId: string, lotPublicId: string): Promise<string | null>
  /**
   * Lotes abiertos y conteos del período en una sola sentencia, para que ambos bloques
   * salgan de la misma foto de la base. Un lote cierra al registrarse o, sin registro,
   * al terminar su ventana; el período se interpreta en `timeZone`.
   */
  readSummary(establishmentId: string, period: Period, timeZone: string, now: Date): Promise<{ openLots: OpenLot[]; period: PeriodCounts }>
  /** Reservas y solicitudes de espera, creación descendente, páginas de 20. */
  listCommitments(establishmentId: string, filter: CommitmentFilter, now: Date): Promise<Page<OperatorCommitment>>
  /** Hechos de los lotes, más recientes primero, páginas de 20. */
  listActivity(establishmentId: string, filter: PageFilter, now: Date): Promise<Page<ActivityEvent>>
}
