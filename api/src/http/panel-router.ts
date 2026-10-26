// K035 · HTTP: panel del establecimiento. Parsing estructural de la consulta y
// representación derivada de OpenAPI; sin SQL ni reglas de negocio.
import { Router } from "express"
import type { Request, Response } from "express"
import type { Actor } from "../application/lots/ports.js"
import type { ActivityEvent, Inventory, OpenLot, OperatorCommitment } from "../application/panel/ports.js"
import type { EstablishmentPanel, PanelUseCases } from "../application/panel/use-cases.js"
import { notAuthenticated } from "../application/errors.js"
import type { Log } from "../application/logging.js"
import type { Authenticate } from "./actor.js"
import { handleError, sendError } from "./errors.js"
import type { HttpSchemas } from "./openapi.js"

class InvalidQueryError extends Error {
  constructor(readonly fields: readonly string[]) { super("Consulta inválida") }
}

/** Solo parámetros conocidos y sin repetir; el resto es error de validación. */
function readQuery(query: Request["query"], allowed: readonly string[]): Record<string, string> {
  const invalid = Object.keys(query).filter(key => !allowed.includes(key) || typeof query[key] !== "string")
  if (invalid.length) throw new InvalidQueryError(invalid)
  return query as Record<string, string>
}

/** Fecha calendario real `YYYY-MM-DD`; febrero 30 no se normaliza. */
function readDate(values: Record<string, string>, key: string, invalid: string[]): string | undefined {
  const value = values[key]
  if (value === undefined) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null
  if (!date || date.toISOString().slice(0, 10) !== value) { invalid.push(key); return undefined }
  return value
}

function readPage(values: Record<string, string>, invalid: string[]): number {
  if (values.page === undefined) return 1
  const page = /^[1-9]\d{0,3}$/.test(values.page) ? Number(values.page) : 0
  if (page < 1 || page > 1000) invalid.push("page")
  return page
}

const toInventory = (inventory: Inventory): HttpSchemas["PanelInventory"] => ({ ...inventory })

function toOpenLot(lot: OpenLot): HttpSchemas["PanelOpenLot"] {
  return {
    id: lot.publicId, description: lot.description, quantity: lot.quantity,
    pickupStartsAt: lot.pickupStartsAt.toISOString(), pickupEndsAt: lot.pickupEndsAt.toISOString(),
    inventory: toInventory(lot.inventory), confirmedReservations: lot.confirmedReservations,
    activeOffers: lot.activeOffers, waitingRequests: lot.waitingRequests,
  }
}

function toPanelBody(panel: EstablishmentPanel): HttpSchemas["EstablishmentPanel"] {
  const { period } = panel
  return {
    establishment: { id: panel.establishment.publicId, name: panel.establishment.name, timeZone: panel.establishment.timeZone },
    asOf: panel.asOf.toISOString(),
    current: {
      lots: panel.current.lots.map(toOpenLot),
      inventory: toInventory(panel.current.inventory),
      confirmedReservations: panel.current.confirmedReservations,
      activeOffers: panel.current.activeOffers,
      waitingRequests: panel.current.waitingRequests,
    },
    period: {
      from: period.from, to: period.to, closedLots: period.closedLots,
      packs: { published: period.publishedPacks, delivered: period.deliveredPacks, unassignable: period.unassignablePacks },
      reservations: { ...period.reservations },
      deliveryRate: { ...period.deliveryRate },
      reservationExpiryRate: { ...period.reservationExpiryRate },
      excluded: { ...period.excluded },
    },
  }
}

function toCommitmentBody(item: OperatorCommitment): HttpSchemas["OperatorCommitment"] {
  return {
    id: item.publicId, kind: item.kind, status: item.status, lot: { ...item.lot }, quantity: item.quantity,
    offeredQuantity: item.offeredQuantity,
    offerExpiresAt: item.offerExpiresAt === null ? null : item.offerExpiresAt.toISOString(),
    createdAt: item.createdAt.toISOString(),
    endedAt: item.endedAt === null ? null : item.endedAt.toISOString(),
  }
}

function toActivityBody(event: ActivityEvent): HttpSchemas["ActivityEvent"] {
  return { id: event.id, kind: event.kind, at: event.at.toISOString(), lot: { ...event.lot }, quantity: event.quantity }
}

function routeId(value: unknown): string { return typeof value === "string" ? value : "" }

export function createPanelRouter(useCases: PanelUseCases, authenticate: Authenticate, log: Log = event => console.error(event)): Router {
  const router = Router()
  const withActor = (handler: (actor: Actor, request: Request, response: Response) => Promise<void>) =>
    async (request: Request, response: Response): Promise<void> => {
      try {
        const actor = await authenticate(request)
        if (actor === null) throw notAuthenticated()
        await handler(actor, request, response)
      } catch (error) {
        if (error instanceof InvalidQueryError) {
          sendError(response, 422, "VALIDATION_ERROR", "Revisa los parámetros indicados.", error.fields.map(field => ({
            path: `/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`, message: "Parámetro desconocido, repetido o con formato inválido.",
          })))
        } else handleError(error, response, log)
      }
    }

  router.get("/establishments/:establishmentId/panel", withActor(async (actor, request, response) => {
    const values = readQuery(request.query, ["from", "to"])
    const invalid: string[] = []
    const from = readDate(values, "from", invalid)
    const to = readDate(values, "to", invalid)
    if (invalid.length) throw new InvalidQueryError(invalid)
    const panel = await useCases.getPanel(actor, routeId(request.params.establishmentId), {
      ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }),
    })
    response.json(toPanelBody(panel))
  }))

  router.get("/establishments/:establishmentId/commitments", withActor(async (actor, request, response) => {
    const values = readQuery(request.query, ["lotId", "state", "page"])
    const invalid: string[] = []
    if (values.state !== undefined && !["active", "ended"].includes(values.state)) invalid.push("state")
    const page = readPage(values, invalid)
    if (invalid.length) throw new InvalidQueryError(invalid)
    const result = await useCases.listCommitments(actor, routeId(request.params.establishmentId), {
      lotId: values.lotId, page, active: values.state === undefined ? undefined : values.state === "active",
    })
    response.json({ items: result.items.map(toCommitmentBody), page: result.page, hasNextPage: result.hasNextPage } satisfies HttpSchemas["OperatorCommitmentPage"])
  }))

  router.get("/establishments/:establishmentId/activity", withActor(async (actor, request, response) => {
    const values = readQuery(request.query, ["lotId", "page"])
    const invalid: string[] = []
    const page = readPage(values, invalid)
    if (invalid.length) throw new InvalidQueryError(invalid)
    const result = await useCases.listActivity(actor, routeId(request.params.establishmentId), { lotId: values.lotId, page })
    response.json({ items: result.items.map(toActivityBody), page: result.page, hasNextPage: result.hasNextPage } satisfies HttpSchemas["ActivityPage"])
  }))

  return router
}
