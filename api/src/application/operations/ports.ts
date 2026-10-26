// K036 · Application: límite hacia Infrastructure para observar la operación (anexos H
// p. 22). Solo lee el estado y escribe el latido del worker; no decide transiciones.

/** Salud que entrega `/health`: proceso, acceso a la base y último ciclo del worker. */
export interface Health { database: 'ok' | 'unavailable'; worker: 'ok' | 'stopped' | 'unknown' }

export type Queue = 'expiries' | 'notifications' | 'photos'

/** Tareas vencidas sin registrar, demora de la más antigua y tareas en error de una cola. */
export interface Backlog { queue: Queue; pending: number; delaySeconds: number | null; failed: number }

/** Tarea que no se reintenta sola, con su código técnico; nunca datos de quien la originó. */
export interface FailedTask { queue: Queue; id: string; attempts: number; code: string | null }

export interface Operations {
  recordWorkerCycle(): Promise<void>
  checkHealth(): Promise<Health>
  readBacklog(): Promise<Backlog[]>
  listFailedTasks(): Promise<FailedTask[]>
}
