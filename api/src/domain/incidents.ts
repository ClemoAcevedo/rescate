// K043 · Domain: reglas puras de las incidencias del lote (RF11, anexos H p. 20 e I p. 26).
// Un reporte no tiene efectos; publicar, actualizar y resolver crean una versión.

export type IncidentStatus = 'reported' | 'open' | 'following' | 'resolved'
export type PublishedIncidentStatus = Exclude<IncidentStatus, 'reported'>
export const INCIDENT_ACTIONS = ['publish', 'update', 'resolve'] as const
export type IncidentAction = typeof INCIDENT_ACTIONS[number]

export const INCIDENT_TEXT_MAX_LENGTH = 2000

export class IncidentRuleError extends Error {
  constructor(readonly reason: 'invalid_reason' | 'invalid_instructions' | 'invalid_transition') {
    super(reason)
  }
}

function normalizeText(value: string, violation: 'invalid_reason' | 'invalid_instructions'): string {
  const text = value.trim()
  // PostgreSQL no almacena NUL en un text: se rechaza como entrada inválida.
  if (!text || text.length > INCIDENT_TEXT_MAX_LENGTH || text.includes('\0')) throw new IncidentRuleError(violation)
  return text
}
export const normalizeIncidentReason = (value: string): string => normalizeText(value, 'invalid_reason')
export const normalizeIncidentInstructions = (value: string): string => normalizeText(value, 'invalid_instructions')

const TRANSITIONS: Record<IncidentAction, { from: readonly IncidentStatus[]; to: PublishedIncidentStatus }> = {
  publish: { from: ['reported'], to: 'open' },
  update: { from: ['open', 'following'], to: 'following' },
  resolve: { from: ['open', 'following'], to: 'resolved' },
}

/** Estado que deja la acción; una resolución no admite versiones posteriores. */
export const incidentStatusAfter = (action: IncidentAction): PublishedIncidentStatus => TRANSITIONS[action].to

export function requireIncidentTransition(current: IncidentStatus, action: IncidentAction): PublishedIncidentStatus {
  const transition = TRANSITIONS[action]
  if (!transition.from.includes(current)) throw new IncidentRuleError('invalid_transition')
  return transition.to
}
