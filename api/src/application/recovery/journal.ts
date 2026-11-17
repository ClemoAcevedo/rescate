import { ApplicationError } from '../errors.js'

export interface RecoveryFacts {
  operation: string
  actorId: string | null
  targetType: 'lot' | 'reservation' | 'waitlist' | 'incident' | 'establishment'
  targetId: string
  intentKey?: string
}
export interface RecoveryTicket { id: string; preparedAt: string }
export interface RecoveryJournal {
  prepare(facts: RecoveryFacts): Promise<RecoveryTicket>
  complete(ticket: RecoveryTicket, result: unknown): Promise<void>
  reject(ticket: RecoveryTicket, definite: boolean): Promise<void>
  close(): void
}

export class RecoveryJournalUnavailableError extends Error {
  constructor() { super('No se pudo confirmar el registro de recuperación'); this.name = 'RecoveryJournalUnavailableError' }
}

/** El registro independiente se prepara antes de la unidad atómica; no se llama bajo el bloqueo del lote. */
export async function auditOperation<T>(journal: RecoveryJournal | null, facts: RecoveryFacts, action: () => Promise<T>): Promise<T> {
  if (!journal) return action()
  const ticket = await journal.prepare(facts)
  let result: T
  try { result = await action() }
  catch (error) {
    // Una falla técnica puede incluir un COMMIT de resultado desconocido. Se conserva
    // como incierta y exige conciliación, sin inferir un rollback ni repetir el efecto.
    await journal.reject(ticket, error instanceof ApplicationError).catch(() => {})
    throw error
  }
  await journal.complete(ticket, result)
  return result
}

type FactsFor<T> = { [K in keyof T]?: T[K] extends (...args: infer A) => unknown ? (...args: A) => RecoveryFacts : never }

/** Instrumenta únicamente los comandos indicados; las lecturas y sus políticas quedan en sus casos de uso. */
export function auditCommands<T extends object>(cases: T, facts: FactsFor<T>, journal: RecoveryJournal | null): T {
  if (!journal) return cases
  const wrapped = { ...cases }
  const source = cases as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  const target = wrapped as Record<string, (...args: unknown[]) => Promise<unknown>>
  for (const [name, describe] of Object.entries(facts)) {
    const operation = source[name]!
    const describeFacts = describe as (...args: unknown[]) => RecoveryFacts
    target[name] = (...args) => auditOperation(journal, describeFacts(...args), () => operation(...args))
  }
  return wrapped
}
