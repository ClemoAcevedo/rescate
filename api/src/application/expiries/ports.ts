// K028 · Application: límites hacia Infrastructure para reclamar y registrar los
// vencimientos de un lote. No exponen pg ni SQL; las decisiones usan el reloj de la base.
import type { LotStatus } from '../../domain/lots.js'

/** Lote reclamado por un trabajador; `attempts` cuenta este reclamo. */
export interface ExpiryClaim {
  lotId: string
  attempts: number
}

/** Lote releído bajo su bloqueo, con el reloj de la base. */
export interface ExpiryState {
  status: LotStatus
  pickupEndsAt: Date
  now: Date
}

export interface ExpiryWriter {
  /**
   * Registra las ofertas vencidas y ofrece lo liberado a quien sigue; si el lote dejó
   * de asignar, cierra su cola y lo retenido pasa a X (ADR 0010). Devuelve las
   * solicitudes cerradas.
   */
  settleQueue(): Promise<number>
  /** RF08: las reservas confirmadas pasan a vencidas con término `at`, y R → X. Devuelve cuántas. */
  expireReservations(at: Date): Promise<number>
  /** published → expired con `closed_at = at`; lo libre pendiente pasa a X (anexos B p. 4). */
  closeLot(at: Date): Promise<void>
  /** Suelta la concesión y reinicia los intentos, en la misma transacción. */
  complete(): Promise<void>
}

export interface LotExpiryRepository {
  /**
   * Reclama el lote con el vencimiento pendiente más antiguo (cierre de un lote
   * publicado u oferta vencida) cuya concesión esté libre y que tenga menos de
   * `maxAttempts` reclamos. Suma un intento y lo concede por `leaseMs` según el reloj
   * de la base. Salta los lotes bloqueados. `null` si no hay trabajo.
   */
  claimNext(leaseMs: number, maxAttempts: number): Promise<ExpiryClaim | null>
  /** Bloquea el lote y lo relee; `null` si no existe. */
  withExpiryTransaction<T>(lotId: string,
    operate: (state: ExpiryState | null, writer: ExpiryWriter) => Promise<T>): Promise<T>
  /**
   * Tras un fallo, pospone el próximo reclamo `retryAfterMs`; `null` no lo pospone.
   * Solo actúa si el lote conserva `attempts`: un trabajador cuya concesión venció no
   * pisa la de quien lo retomó.
   */
  release(lotId: string, attempts: number, retryAfterMs: number | null): Promise<void>
}
