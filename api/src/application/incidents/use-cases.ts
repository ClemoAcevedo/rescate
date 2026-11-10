// K043 · Application: reportar y publicar incidencias (RF11). Autoriza, reproduce los
// reintentos y aplica la transición; Infrastructure ejecuta la transacción bajo bloqueo.
import { incidentStatusAfter, normalizeIncidentInstructions, normalizeIncidentReason,
  requireIncidentTransition } from '../../domain/incidents.js'
import type { Actor } from '../lots/ports.js'
import { idempotencyConflict, incidentNotFound, incidentVersionConflict, lotNotFound, notAuthorized } from '../errors.js'
import type { IncidentCommand, IncidentRepository, IncidentVersionResult } from './ports.js'

function sameCommand(prior: IncidentVersionResult, incidentId: string, command: IncidentCommand): boolean {
  return prior.incidentId === incidentId && prior.status === incidentStatusAfter(command.action)
    && prior.version === command.version + 1 && prior.reason === command.reason && prior.instructions === command.instructions
}

export function createIncidentUseCases(repository: IncidentRepository) {
  return {
    /** Solo operadores miembros: el reporte aún no publicado no se muestra a los vinculados. */
    async list(actor: Actor, lotId: string) {
      const lot = await repository.findLot(lotId)
      if (!lot) throw lotNotFound()
      if (!await repository.isMember(actor.userId, lot.establishmentId)) throw notAuthorized()
      return repository.listByLot(lotId)
    },

    /** Registra el problema sin tocar el lote: no bloquea, cancela ni avisa. */
    async report(actor: Actor, lotId: string, input: { reason: string; idempotencyKey: string }) {
      const reason = normalizeIncidentReason(input.reason)
      lotId = lotId.toLowerCase()
      return repository.withReport(actor.userId, lotId, input.idempotencyKey.toLowerCase(), async (writer) => {
        const prior = await writer.prior()
        if (prior) {
          if (prior.lotId !== lotId || prior.reason !== reason) throw idempotencyConflict()
          return prior
        }
        // Sin acceso responde igual que un lote inexistente.
        if (!await writer.hasAccess()) throw lotNotFound()
        return writer.insert(reason)
      })
    },

    /** Publica, actualiza o resuelve creando una versión con sus destinatarios. */
    async command(actor: Actor, incidentId: string, input: IncidentCommand) {
      const command = { ...input, reason: normalizeIncidentReason(input.reason),
        instructions: normalizeIncidentInstructions(input.instructions), idempotencyKey: input.idempotencyKey.toLowerCase() }
      incidentId = incidentId.toLowerCase()
      // Rechazar al operador ajeno antes de competir con reservas por el bloqueo del lote.
      const incident = await repository.findIncident(incidentId)
      if (!incident || !await repository.isMember(actor.userId, incident.establishmentId)) throw incidentNotFound()
      return repository.withCommand(actor.userId, incidentId, command.idempotencyKey, async (state, writer) => {
        if (!state || !await writer.isMember(actor.userId)) throw incidentNotFound()
        const prior = await writer.prior(actor.userId, command.idempotencyKey)
        if (prior) {
          if (!sameCommand(prior, incidentId, command)) throw idempotencyConflict()
          return prior
        }
        if (state.version !== command.version) throw incidentVersionConflict()
        return writer.publish(actor.userId, command, requireIncidentTransition(state.status, command.action))
      })
    },
  }
}
export type IncidentUseCases = ReturnType<typeof createIncidentUseCases>
