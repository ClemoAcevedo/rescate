// K028 · Application: vencimientos de lotes, reservas y ofertas (RF08). La API ya decide
// con el cierre del lote y la hora de cada oferta aunque el trabajador esté detenido;
// este caso de uso registra el efecto una sola vez, bajo el bloqueo del lote y con el
// instante del vencimiento, no el del proceso.
import { isDueToExpire } from '../../domain/lots.js'
import type { LotExpiryRepository } from './ports.js'
import { errorCode } from '../logging.js'
import type { Log } from '../logging.js'

/**
 * Concesión de un reclamo, intentos máximos por lote y espera base entre intentos. Un
 * trabajador que muere conserva el reclamo hasta que vence la concesión.
 */
export const EXPIRY_LIMITS = { leaseMs: 60_000, maxAttempts: 5, retryDelayMs: 30_000 }

export interface ExpiryResult {
  lotClosed: boolean
  expiredReservations: number
  closedEntries: number
}

export function createExpiryUseCases(repository: LotExpiryRepository, log: Log,
  limits: typeof EXPIRY_LIMITS = EXPIRY_LIMITS) {
  /**
   * Registra lo vencido de un lote: ofertas cuya hora pasó y, si el lote cerró, su
   * cola, sus reservas confirmadas y el propio lote. Repetirlo no libera de nuevo.
   */
  async function expireLot(lotId: string): Promise<ExpiryResult> {
    return repository.withExpiryTransaction(lotId.toLowerCase(), async (state, writer) => {
      if (!state) return { lotClosed: false, expiredReservations: 0, closedEntries: 0 }
      const closedEntries = await writer.settleQueue()
      const lotClosed = isDueToExpire(state, state.now)
      // Las reservas terminan al cierre, no cuando se registra (ADR 0007).
      const expiredReservations = lotClosed ? await writer.expireReservations(state.pickupEndsAt) : 0
      if (lotClosed) await writer.closeLot(state.pickupEndsAt)
      await writer.complete()
      return { lotClosed, expiredReservations, closedEntries }
    })
  }

  return {
    expireLot,

    /**
     * Reclama y registra los vencimientos de un lote; `false` si no había trabajo. Un
     * fallo pospone el lote y, al agotar los intentos, lo deja sin reclamar para revisión.
     */
    async expireNext(): Promise<boolean> {
      const claim = await repository.claimNext(limits.leaseMs, limits.maxAttempts)
      if (claim === null) return false
      try {
        const result = await expireLot(claim.lotId)
        log({ event: 'lot_expiry', lotId: claim.lotId, attempts: claim.attempts, ...result })
      } catch (error) {
        const exhausted = claim.attempts >= limits.maxAttempts
        await repository.release(claim.lotId, claim.attempts, exhausted ? null : limits.retryDelayMs * claim.attempts)
        log({ event: exhausted ? 'lot_expiry_exhausted' : 'lot_expiry_retry', lotId: claim.lotId,
          attempts: claim.attempts, code: errorCode(error) })
      }
      return true
    },
  }
}

export type ExpiryUseCases = ReturnType<typeof createExpiryUseCases>
