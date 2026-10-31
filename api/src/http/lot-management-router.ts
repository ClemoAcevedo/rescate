import { Router } from 'express'
import type { LotManagement } from '../application/lots/management.js'
import { notAuthenticated } from '../application/errors.js'
import type { Authenticate } from './actor.js'
import type { Request } from 'express'
import type { Log } from '../application/logging.js'
import type { HttpSchemas } from './openapi.js'
import type { LotCommand } from '../domain/lot-management.js'
import { LotManagementError, validateLotCommand } from '../domain/lot-management.js'
import { handleError, sendError } from './errors.js'

export function createLotManagementRouter(useCases: LotManagement, authenticate: Authenticate,
  protectCommand: (request: Request) => Promise<void>, log: Log): Router {
  const router = Router()
  router.all('/lots/:lotId/management', async (request, response, next) => {
    if (!['GET', 'POST'].includes(request.method)) { next(); return }
    try {
      const actor = await authenticate(request)
      if (!actor) throw notAuthenticated()
      const lotId = typeof request.params.lotId === 'string' ? request.params.lotId : ''
      if (request.method === 'GET') {
        const result: HttpSchemas['LotManagementResponse'] = await useCases.get(actor, lotId)
        response.json(result)
        return
      }
      await protectCommand(request)
      if (!request.is('application/json')) {
        sendError(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Se requiere application/json.')
        return
      }
      const body = request.body as Record<string, unknown> | null
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some(key => !['action','version','idempotencyKey','reason','quantity'].includes(key))
          || typeof body.reason !== 'string' || typeof body.idempotencyKey !== 'string') throw new LotManagementError('invalid_command')
      const command = body as unknown as LotCommand
      validateLotCommand(command)
      const result: HttpSchemas['LotManagementResponse'] = await useCases.command(actor, lotId, command)
      response.json(result)
    } catch (error) {
      if (error instanceof LotManagementError) {
        const messages = { invalid_command: 'Revisa la acción, cantidad, motivo, versión y clave de la operación.',
          closed: 'El lote no está publicado o su ventana de retiro terminó.',
          insufficient_stock: 'Solo puedes descontar unidades libres. Las unidades ofrecidas, reservadas o entregadas se conservan.',
          already_paused: 'El lote ya está pausado.', not_paused: 'El lote no está pausado.' }
        sendError(response, error.reason === 'invalid_command' ? 422 : 409,
          error.reason === 'invalid_command' ? 'VALIDATION_ERROR' : 'CONFLICT', messages[error.reason])
      } else handleError(error, response, log)
    }
  })
  return router
}
