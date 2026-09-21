// K010 · HTTP: rutas de borrador y publicación de lotes (RF02). Handlers
// ligeros: validación estructural, llamada al caso de uso y traducción de la
// respuesta. Sin SQL, sin pg y sin reglas de negocio.

import { Router } from "express"
import type { Request, Response } from "express"
import type { Lot, LotStatus } from "../domain/lots.js"
import type { LotUseCases } from "../application/lots/use-cases.js"
import type { Actor } from "../application/lots/ports.js"
import { notAuthenticated } from "../application/errors.js"
import type { Authenticate } from "./actor.js"
import { handleError, sendError } from "./errors.js"

export interface LotsRouterOptions {
  useCases: LotUseCases
  authenticate: Authenticate
  log?: (error: unknown) => void
}

/** Representación HTTP del lote: expone el identificador público, no el bigint. */
interface LotBody {
  id: string
  establishmentId: string
  status: LotStatus
  version: number
  description: string
  category: string
  quantity: number
  conditions: string | null
  address: string
  latitude: number
  longitude: number
  timeZone: string
  pickupStartsAt: string
  pickupEndsAt: string
  createdAt: string
  updatedAt: string
  publishedAt: string | null
}

function toBody(lot: Lot): LotBody {
  return {
    id: lot.publicId,
    establishmentId: lot.establishmentId,
    status: lot.status,
    version: lot.version,
    description: lot.declaration.description,
    category: lot.declaration.category,
    quantity: lot.declaration.quantity,
    conditions: lot.declaration.conditions,
    address: lot.declaration.address,
    latitude: lot.declaration.latitude,
    longitude: lot.declaration.longitude,
    timeZone: lot.declaration.timeZone,
    pickupStartsAt: lot.declaration.pickupStartsAt.toISOString(),
    pickupEndsAt: lot.declaration.pickupEndsAt.toISOString(),
    createdAt: lot.createdAt.toISOString(),
    updatedAt: lot.updatedAt.toISOString(),
    publishedAt: lot.publishedAt === null ? null : lot.publishedAt.toISOString(),
  }
}

class InvalidRequestError extends Error {
  readonly fields: readonly string[]

  constructor(fields: readonly string[]) {
    super(`Campos inválidos: ${fields.join(", ")}`)
    this.name = "InvalidRequestError"
    this.fields = fields
  }
}

type Payload = Record<string, unknown>

function asObject(value: unknown): Payload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidRequestError(["body"])
  }
  return value as Payload
}

/**
 * Validación estructural: responde si la entrada tiene la forma esperada.
 * Las reglas del negocio las decide Domain con los valores ya tipados.
 */
function readDeclaration(payload: Payload): {
  description: string
  category: string
  quantity: number
  conditions: string | null
  address: string
  latitude: number
  longitude: number
  timeZone: string
  pickupStartsAt: Date
  pickupEndsAt: Date
} {
  const invalid: string[] = []

  const text = (field: string): string => {
    const value = payload[field]
    if (typeof value !== "string") {
      invalid.push(field)
      return ""
    }
    return value
  }

  const numeric = (field: string): number => {
    const value = payload[field]
    // Se aceptan solo números JSON: un texto numérico no se convierte en silencio.
    if (typeof value !== "number" || !Number.isFinite(value)) {
      invalid.push(field)
      return Number.NaN
    }
    return value
  }

  const instant = (field: string): Date => {
    const value = payload[field]
    if (typeof value !== "string") {
      invalid.push(field)
      return new Date(Number.NaN)
    }
    const parsed = new Date(value)
    // ISO 8601 con zona explícita: una fecha sin desfase es ambigua.
    if (!Number.isFinite(parsed.getTime()) || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
      invalid.push(field)
      return new Date(Number.NaN)
    }
    return parsed
  }

  const conditionsValue = payload.conditions
  let conditions: string | null = null
  if (conditionsValue !== undefined && conditionsValue !== null) {
    if (typeof conditionsValue !== "string") invalid.push("conditions")
    else conditions = conditionsValue
  }

  const declaration = {
    description: text("description"),
    category: text("category"),
    quantity: numeric("quantity"),
    conditions,
    address: text("address"),
    latitude: numeric("latitude"),
    longitude: numeric("longitude"),
    timeZone: text("timeZone"),
    pickupStartsAt: instant("pickupStartsAt"),
    pickupEndsAt: instant("pickupEndsAt"),
  }

  if (invalid.length > 0) throw new InvalidRequestError(invalid)
  return declaration
}

function readExpectedVersion(payload: Payload): number {
  const value = payload.expectedVersion
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new InvalidRequestError(["expectedVersion"])
  }
  return value
}

function readEstablishmentId(payload: Payload): string {
  const value = payload.establishmentId
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value.trim())) {
    throw new InvalidRequestError(["establishmentId"])
  }
  return value.trim()
}

/** El identificador de ruta llega como texto; el repositorio valida su forma. */
function readPublicId(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function readStatuses(value: unknown): readonly LotStatus[] | undefined {
  if (value === undefined) return undefined
  const requested = (typeof value === "string" ? value.split(",") : []).map((item) => item.trim())
  const allowed: LotStatus[] = ["draft", "published"]
  const statuses = requested.filter((item): item is LotStatus => (allowed as string[]).includes(item))
  if (statuses.length !== requested.length || statuses.length === 0) {
    throw new InvalidRequestError(["status"])
  }
  return statuses
}

export function createLotsRouter(options: LotsRouterOptions): Router {
  const { useCases, authenticate } = options
  const log = options.log ?? ((error: unknown) => console.error("Error no controlado en /lots", error))
  const router = Router()

  const withActor = (
    handler: (actor: Actor, request: Request, response: Response) => Promise<void>,
  ) => async (request: Request, response: Response): Promise<void> => {
    try {
      const actor = await authenticate(request)
      if (actor === null) throw notAuthenticated()
      await handler(actor, request, response)
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        sendError(response, 400, "invalid_request", "La solicitud no tiene el formato esperado.", error.fields)
        return
      }
      handleError(error, response, log)
    }
  }

  router.post("/", withActor(async (actor, request, response) => {
    const payload = asObject(request.body)
    const lot = await useCases.createDraft(actor, {
      establishmentId: readEstablishmentId(payload),
      declaration: readDeclaration(payload),
    })
    response.status(201).json(toBody(lot))
  }))

  router.get("/", withActor(async (actor, request, response) => {
    const query = request.query.establishmentId
    const establishmentId = readEstablishmentId({ establishmentId: typeof query === "string" ? query : undefined })
    const statuses = readStatuses(request.query.status)
    const lots = await useCases.listEstablishmentLots(actor, establishmentId, statuses)
    response.json({ items: lots.map(toBody) })
  }))

  router.get("/:id", withActor(async (actor, request, response) => {
    const lot = await useCases.getLot(actor, readPublicId(request.params.id))
    response.json(toBody(lot))
  }))

  router.patch("/:id", withActor(async (actor, request, response) => {
    const payload = asObject(request.body)
    const lot = await useCases.updateDraft(actor, {
      publicId: readPublicId(request.params.id),
      expectedVersion: readExpectedVersion(payload),
      declaration: readDeclaration(payload),
    })
    response.json(toBody(lot))
  }))

  router.post("/:id/publication", withActor(async (actor, request, response) => {
    const payload = asObject(request.body)
    const lot = await useCases.publish(actor, {
      publicId: readPublicId(request.params.id),
      expectedVersion: readExpectedVersion(payload),
    })
    response.json(toBody(lot))
  }))

  return router
}
