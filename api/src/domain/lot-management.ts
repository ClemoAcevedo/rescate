import type { LotStatus } from './lots.js'

export type LotAction = 'reduce_stock' | 'pause' | 'resume' | 'withdraw'
export interface LotCommand {
  action: LotAction
  version: number
  idempotencyKey: string
  reason: string
  quantity?: number
}
export interface ManagedLot {
  status: LotStatus
  version: number
  paused: boolean
  freeQuantity: number
  offeredQuantity: number
  reservedQuantity: number
  deliveredQuantity: number
  unassignableQuantity: number
}
export class LotManagementError extends Error {
  constructor(readonly reason: 'invalid_command' | 'closed' | 'insufficient_stock' | 'already_paused' | 'not_paused') {
    super(reason)
  }
}

/** Q y el contenido publicado se conservan. Solo se retiran unidades todavía libres. */
export function validateLotCommand(command: LotCommand): void {
  if (!['reduce_stock', 'pause', 'resume', 'withdraw'].includes(command.action)
      || !Number.isSafeInteger(command.version) || command.version < 1
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(command.idempotencyKey)
      || typeof command.reason !== 'string' || !command.reason.trim() || command.reason.trim().length > 500
      || (command.action === 'reduce_stock'
        ? !Number.isSafeInteger(command.quantity) || command.quantity! < 1 || command.quantity! > 2147483647
        : command.quantity !== undefined)) throw new LotManagementError('invalid_command')
}

export function requireLotCommand(state: ManagedLot, command: LotCommand, pickupEndsAt: Date, at: Date): void {
  validateLotCommand(command)
  if (state.status !== 'published' || at >= pickupEndsAt) throw new LotManagementError('closed')
  if (command.action === 'reduce_stock' && command.quantity! > state.freeQuantity) throw new LotManagementError('insufficient_stock')
  if (command.action === 'pause' && state.paused) throw new LotManagementError('already_paused')
  if (command.action === 'resume' && !state.paused) throw new LotManagementError('not_paused')
}
