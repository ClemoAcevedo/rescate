// K043 · HTTP: incidencias del lote (RF11). Solo transporta; permisos, reintentos y
// transiciones los decide Application.
import { Router } from 'express'
import type { Request } from 'express'
import type { IncidentCommand } from '../application/incidents/ports.js'
import type { IncidentUseCases } from '../application/incidents/use-cases.js'
import type { IncidentAction } from '../domain/incidents.js'
import { INCIDENT_ACTIONS } from '../domain/incidents.js'
import type { Log } from '../application/logging.js'
import type { Authenticate } from './actor.js'
import type { HttpSchemas } from './openapi.js'
import { createActorRoute, id, isUuid, readBody } from './reservations-router.js'

const isText = (value: unknown) => typeof value === 'string'
const isVersion = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2147483647
const isAction = (value: unknown) => INCIDENT_ACTIONS.includes(value as IncidentAction)

export function createIncidentsRouter(cases: IncidentUseCases, authenticate: Authenticate,
  protectCommand: (request: Request) => Promise<void>, log: Log = event => console.error(event)): Router {
  const router = Router()
  const withActor = createActorRoute(authenticate, protectCommand, log)

  router.get('/lots/:lotId/incidents', withActor(async (actor, request, response) => {
    const items: HttpSchemas['IncidentList']['items'] = await cases.list(actor, id(request.params.lotId))
    response.json({ items } satisfies HttpSchemas['IncidentList'])
  }))

  router.post('/lots/:lotId/incidents', withActor(async (actor, request, response) => {
    const body = readBody(request.body, { reason: isText, idempotencyKey: isUuid })
    const report = await cases.report(actor, id(request.params.lotId),
      { reason: body.reason!, idempotencyKey: body.idempotencyKey! })
    response.status(201).json(report satisfies HttpSchemas['IncidentReport'])
  }))

  router.post('/incidents/:incidentId/versions', withActor(async (actor, request, response) => {
    const body = readBody(request.body, { action: isAction, version: isVersion, reason: isText,
      instructions: isText, idempotencyKey: isUuid }) as unknown as IncidentCommand
    const result = await cases.command(actor, id(request.params.incidentId), body)
    response.status(201).json(result satisfies HttpSchemas['IncidentVersionResult'])
  }))

  return router
}
