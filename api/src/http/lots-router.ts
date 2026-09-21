// HTTP: parsing estructural, actor y representación derivada de OpenAPI.
import { Router } from "express"
import type { Request, Response } from "express"
import type { Lot, LotDeclaration } from "../domain/lots.js"
import type { LotUseCases } from "../application/lots/use-cases.js"
import type { Actor } from "../application/lots/ports.js"
import { notAuthenticated } from "../application/errors.js"
import type { Authenticate } from "./actor.js"
import type { HttpSchemas } from "./openapi.js"
import { handleError, sendError } from "./errors.js"

export interface LotsRouterOptions {
  useCases: LotUseCases
  authenticate: Authenticate
  log?: (error: unknown) => void
}

function toBody(lot: Lot): HttpSchemas["LotResponse"] {
  return {
    id: lot.publicId,
    establishmentId: lot.establishmentPublicId,
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
    publishedAt: lot.publishedAt === null ? null : lot.publishedAt.toISOString(),
  }
}

class InvalidRequestError extends Error {
  constructor(readonly fields: readonly string[]) { super("Entrada inválida") }
}
type Payload = Record<string, unknown>
const declarationFields = ["description", "category", "quantity", "conditions", "address", "latitude", "longitude", "timeZone", "pickupStartsAt", "pickupEndsAt"] as const satisfies readonly (keyof HttpSchemas["CreateLotDraftRequest"])[]

function readPayload(value: unknown, allowed: readonly string[]): Payload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidRequestError([""])
  const extra = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extra.length) throw new InvalidRequestError(extra)
  return value as Payload
}

function readDeclaration(payload: Payload, partial: boolean): Partial<LotDeclaration> {
  const result: Record<string, unknown> = {}
  const invalid: string[] = []
  for (const field of declarationFields) {
    if (!Object.hasOwn(payload, field)) {
      if (!partial && field !== "conditions") invalid.push(field)
      else if (!partial) result.conditions = null
      continue
    }
    const value = payload[field]
    if (field === "conditions" && value === null) { result[field] = null; continue }
    if (["quantity", "latitude", "longitude"].includes(field)) {
      if (typeof value !== "number" || !Number.isFinite(value)) invalid.push(field)
      else result[field] = value
    } else if (typeof value !== "string") {
      invalid.push(field)
    } else if (field === "pickupStartsAt" || field === "pickupEndsAt") {
      // RFC 3339: zona explícita, fecha real; no aceptar normalización de febrero 30.
      const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(value)
      const parsed = new Date(value)
      const days = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate() : 0
      if (!match || Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[3]) < 1 || Number(match[3]) > days || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 || !Number.isFinite(parsed.getTime())) invalid.push(field)
      else result[field] = parsed
    } else result[field] = value
  }
  if (invalid.length) throw new InvalidRequestError(invalid)
  return result as Partial<LotDeclaration>
}

function readVersion(payload: Payload): number {
  if (typeof payload.version !== "number" || !Number.isSafeInteger(payload.version) || payload.version < 1) throw new InvalidRequestError(["version"])
  return payload.version
}
function routeId(value: unknown): string { return typeof value === "string" ? value : "" }

export function createLotsRouter({ useCases, authenticate, log = console.error }: LotsRouterOptions): Router {
  const router = Router()
  const withActor = (handler: (actor: Actor, request: Request, response: Response) => Promise<void>) =>
    async (request: Request, response: Response): Promise<void> => {
      try {
        const actor = await authenticate(request)
        if (actor === null) throw notAuthenticated()
        // K008 sustituirá Authenticate y aplicará Origin/CSRF en HTTP a los comandos.
        if (request.method !== "GET" && !request.is("application/json")) {
          sendError(response, 415, "UNSUPPORTED_MEDIA_TYPE", "Se requiere application/json.")
          return
        }
        await handler(actor, request, response)
      } catch (error) {
        if (error instanceof InvalidRequestError) {
          sendError(response, 422, "VALIDATION_ERROR", "Revisa los campos indicados.", error.fields.map((field) => ({
            path: field === "" ? "" : `/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`,
            message: "Campo desconocido, ausente o con formato inválido.",
          })))
        } else handleError(error, response, log)
      }
    }

  router.post("/establishments/:establishmentId/lots", withActor(async (actor, request, response) => {
    const payload = readPayload(request.body, declarationFields)
    const lot = await useCases.createDraft(actor, {
      establishmentId: routeId(request.params.establishmentId),
      declaration: readDeclaration(payload, false) as LotDeclaration,
    })
    response.status(201).json(toBody(lot))
  }))
  router.get("/lots/:lotId", withActor(async (actor, request, response) => {
    response.json(toBody(await useCases.getLot(actor, routeId(request.params.lotId))))
  }))
  router.patch("/lots/:lotId", withActor(async (actor, request, response) => {
    const payload = readPayload(request.body, ["version", ...declarationFields])
    const version = readVersion(payload)
    if (Object.keys(payload).length < 2) throw new InvalidRequestError([""])
    response.json(toBody(await useCases.updateDraft(actor, {
      publicId: routeId(request.params.lotId), expectedVersion: version,
      declaration: readDeclaration(payload, true),
    })))
  }))
  router.post("/lots/:lotId/publish", withActor(async (actor, request, response) => {
    const payload = readPayload(request.body, ["version"])
    response.json(toBody(await useCases.publish(actor, {
      publicId: routeId(request.params.lotId), expectedVersion: readVersion(payload),
    })))
  }))
  return router
}
