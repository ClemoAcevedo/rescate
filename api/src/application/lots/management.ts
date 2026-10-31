import { requireLotCommand, validateLotCommand } from '../../domain/lot-management.js'
import type { LotCommand, ManagedLot } from '../../domain/lot-management.js'
import type { Actor } from './ports.js'
import { idempotencyConflict, InventoryDiscrepancyError, lotNotFound, notAuthorized, versionConflict } from '../errors.js'

export interface LotOperation {
  id: string
  action: LotCommand['action']
  quantity: number | null
  reason: string
  createdAt: string
  version: number
}
export interface LotManagementView extends ManagedLot { history: LotOperation[] }
export interface ManagementState {
  lot: ManagedLot
  establishmentId: string
  pickupEndsAt: Date
  at: Date
  reconciled: boolean
}
export interface StoredCommand {
  lotId: string
  command: LotCommand
  result: LotManagementView
}
export interface ManagementWriter {
  settle(): Promise<ManagementState>
  isMember(userId: string): Promise<boolean>
  prior(userId: string, key: string): Promise<StoredCommand | null>
  apply(userId: string, command: LotCommand): Promise<LotManagementView>
}
export interface LotManagementRepository {
  find(lotId: string): Promise<{ establishmentId: string } | null>
  isMember(userId: string, establishmentId: string): Promise<boolean>
  read(lotId: string): Promise<LotManagementView>
  withCommand<T>(userId: string, lotId: string, key: string,
    operate: (state: ManagementState | null, writer: ManagementWriter) => Promise<T>): Promise<T>
}

export function createLotManagement(repository: LotManagementRepository) {
  async function authorize(actor: Actor, lotId: string) {
    const lot = await repository.find(lotId)
    if (!lot) throw lotNotFound()
    if (!await repository.isMember(actor.userId, lot.establishmentId)) throw notAuthorized()
  }
  return {
    async get(actor: Actor, lotId: string) {
      await authorize(actor, lotId)
      return repository.read(lotId)
    },
    async command(actor: Actor, lotId: string, input: LotCommand) {
      validateLotCommand(input)
      lotId = lotId.toLowerCase()
      const command = { ...input, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey.toLowerCase() }
      // Rechazar al operador ajeno antes de competir con reservas por el bloqueo del lote.
      await authorize(actor, lotId)
      return repository.withCommand(actor.userId, lotId, command.idempotencyKey, async (state, writer) => {
        if (!state) throw lotNotFound()
        if (!await writer.isMember(actor.userId)) throw notAuthorized()
        const prior = await writer.prior(actor.userId, command.idempotencyKey)
        if (prior) {
          if (prior.lotId !== lotId || prior.command.action !== command.action
              || prior.command.version !== command.version || prior.command.reason !== command.reason
              || prior.command.quantity !== command.quantity) throw idempotencyConflict()
          return prior.result
        }
        const current = command.action === 'reduce_stock' ? await writer.settle() : state
        if (current.lot.version !== command.version) throw versionConflict()
        if (!current.reconciled) throw new InventoryDiscrepancyError(lotId)
        requireLotCommand(current.lot, command, current.pickupEndsAt, current.at)
        return writer.apply(actor.userId, command)
      })
    },
  }
}
export type LotManagement = ReturnType<typeof createLotManagement>
