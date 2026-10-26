// K035 · Application: panel del establecimiento (RF10) y resultados básicos (RF12).
// Autoriza por pertenencia, resuelve el período y arma los indicadores con Domain.
// Solo lectura: no bloquea lotes ni modifica compromisos.

import { localDate, rate, resolvePeriod } from "../../domain/panel.js"
import type { Period, Rate } from "../../domain/panel.js"
import { currentStatus, endedAt } from "../../domain/reservations.js"
import type { ReservationStatus } from "../../domain/reservations.js"
import { currentWaitlistStatus, waitlistEndedAt } from "../../domain/waitlist.js"
import type { WaitlistStatus } from "../../domain/waitlist.js"
import { establishmentNotFound, lotNotFound, notAuthorized } from "../errors.js"
import type { Actor, Clock } from "../lots/ports.js"
import type {
  ActivityEvent, CommitmentFilter, Inventory, OpenLot, OperatorCommitment, Page, PanelEstablishment, PanelRepository, PeriodCounts,
} from "./ports.js"

export interface EstablishmentPanel {
  establishment: { publicId: string; name: string; timeZone: string }
  asOf: Date
  current: {
    lots: OpenLot[]
    inventory: Inventory
    confirmedReservations: number
    activeOffers: number
    waitingRequests: number
  }
  period: Period & PeriodCounts & {
    /** Packs retirados sobre packs publicados (informe E1 p. 5). */
    deliveryRate: Rate
    /** Reservas vencidas sobre reservas que llegaron a confirmarse (informe E1 p. 5). */
    reservationExpiryRate: Rate
  }
}

export interface PageRequest { lotId?: string; page: number }

export interface PanelUseCases {
  getPanel(actor: Actor, establishmentId: string, requested: Partial<Period>): Promise<EstablishmentPanel>
  listCommitments(actor: Actor, establishmentId: string, filter: PageRequest & { active?: boolean }): Promise<Page<OperatorCommitment> & { page: number }>
  listActivity(actor: Actor, establishmentId: string, filter: PageRequest): Promise<Page<ActivityEvent> & { page: number }>
}

const sum = (lots: readonly OpenLot[], pick: (lot: OpenLot) => number): number => lots.reduce((total, lot) => total + pick(lot), 0)

export function createPanelUseCases(repository: PanelRepository, now: Clock): PanelUseCases {
  /** Solo un operador con membership actual ve el panel; otro establecimiento no expone datos. */
  async function authorize(actor: Actor, publicId: string): Promise<PanelEstablishment> {
    const establishment = await repository.findEstablishment(publicId)
    if (establishment === null) throw establishmentNotFound()
    if (!(await repository.isMemberOfEstablishment(actor.userId, establishment.id))) throw notAuthorized()
    return establishment
  }

  /** Un lote de otro establecimiento se responde igual que uno inexistente. */
  async function lotFilter(establishment: PanelEstablishment, filter: PageRequest): Promise<CommitmentFilter> {
    if (filter.lotId === undefined) return { page: filter.page }
    const lotId = await repository.findLot(establishment.id, filter.lotId)
    if (lotId === null) throw lotNotFound()
    return { lotId, page: filter.page }
  }

  return {
    async getPanel(actor, establishmentId, requested) {
      const establishment = await authorize(actor, establishmentId)
      const at = now()
      const period = resolvePeriod(requested, localDate(at, establishment.timeZone))
      const summary = await repository.readSummary(establishment.id, period, establishment.timeZone, at)
      const lots = summary.openLots
      const counts = summary.period
      return {
        establishment: { publicId: establishment.publicId, name: establishment.name, timeZone: establishment.timeZone },
        asOf: at,
        // Los totales son la suma de las filas mostradas: cuadran por construcción.
        current: {
          lots,
          inventory: {
            free: sum(lots, lot => lot.inventory.free),
            offered: sum(lots, lot => lot.inventory.offered),
            reserved: sum(lots, lot => lot.inventory.reserved),
            delivered: sum(lots, lot => lot.inventory.delivered),
            unassignable: sum(lots, lot => lot.inventory.unassignable),
          },
          confirmedReservations: sum(lots, lot => lot.confirmedReservations),
          activeOffers: sum(lots, lot => lot.activeOffers),
          waitingRequests: sum(lots, lot => lot.waitingRequests),
        },
        period: {
          ...period,
          ...counts,
          // Solo la entrega acreditada aporta al numerador (anexos A p. 3).
          deliveryRate: rate(counts.deliveredPacks, counts.publishedPacks),
          reservationExpiryRate: rate(counts.reservations.expired, counts.reservations.confirmed),
        },
      }
    },

    async listCommitments(actor, establishmentId, filter) {
      const establishment = await authorize(actor, establishmentId)
      const at = now()
      const result = await repository.listCommitments(establishment.id, { ...(await lotFilter(establishment, filter)), active: filter.active }, at)
      const window = (item: OperatorCommitment) => ({ pickupEndsAt: item.pickupEndsAt })
      return {
        // Estado vigente al responder, como en las vistas del titular (RF08).
        items: result.items.map(item => item.kind === "reservation"
          ? { ...item,
            status: currentStatus(item.status as ReservationStatus, item.pickupEndsAt, at),
            endedAt: endedAt(item.status as ReservationStatus, item.endedAt, item.pickupEndsAt, at) }
          : { ...item,
            status: currentWaitlistStatus({ status: item.status as WaitlistStatus, offerExpiresAt: item.offerExpiresAt }, window(item), at),
            endedAt: waitlistEndedAt({ status: item.status as WaitlistStatus, offerExpiresAt: item.offerExpiresAt, endedAt: item.endedAt }, window(item), at) }),
        hasNextPage: result.hasNextPage,
        page: filter.page,
      }
    },

    async listActivity(actor, establishmentId, filter) {
      const establishment = await authorize(actor, establishmentId)
      return { ...(await repository.listActivity(establishment.id, await lotFilter(establishment, filter), now())), page: filter.page }
    },
  }
}
