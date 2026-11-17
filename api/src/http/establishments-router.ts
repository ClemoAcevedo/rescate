import { Router } from 'express'
import type { Request, Response } from 'express'
import type { IdentityUseCases } from '../application/identity/use-cases.js'
import { IdentityError } from '../application/identity/errors.js'
import { notAuthenticated } from '../application/errors.js'
import type { Log } from '../application/logging.js'
import type { Authenticate } from './actor.js'
import { handleError } from './errors.js'
import type { HttpSchemas } from './openapi.js'

export function createEstablishmentsRouter(useCases: IdentityUseCases, authenticate: Authenticate, log: Log) {
  const router = Router()
  const run = (handler: (req: Request, res: Response, userId: string) => Promise<void>) => async (req: Request, res: Response) => {
    try {
      const actor = await authenticate(req)
      if (!actor) throw notAuthenticated()
      await handler(req, res, actor.userId)
    } catch (error) { handleError(error, res, log) }
  }
  router.get('/establishments', run(async (req, res, userId) => {
    const invalid = Object.keys(req.query).filter(key => !['query', 'page'].includes(key))
    const query = req.query.query ?? ''
    const rawPage = req.query.page ?? '1'
    if (typeof query !== 'string') invalid.push('query')
    if (typeof rawPage !== 'string' || !/^[1-9]\d{0,3}$/.test(rawPage)) invalid.push('page')
    if (invalid.length) throw new IdentityError('invalid_input', invalid)
    const body: HttpSchemas['OperableEstablishmentPage'] = await useCases.searchEstablishments(userId, { query: query as string, page: Number(rawPage) })
    res.json(body)
  }))
  router.get('/establishments/:establishmentId', run(async (req, res, userId) => {
    const id = String(req.params.establishmentId)
    // Las PK públicas de este recurso son UUID; una forma ajena no llega a PostgreSQL.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new IdentityError('invalid_input', ['establishmentId'])
    const body: HttpSchemas['OperableEstablishmentDetails'] = await useCases.getEstablishment(userId, id)
    res.json(body)
  }))
  return router
}
