// K043 · Application: límites hacia Infrastructure para las incidencias. No exponen pg ni
// SQL; los comandos que crean versiones reciben el estado bajo el bloqueo del lote.
import type { IncidentAction, IncidentStatus, PublishedIncidentStatus } from '../../domain/incidents.js'

export interface IncidentReport { id: string; lotId: string; reason: string; createdAt: string }

/** Resultado de un comando: identifica la versión creada y no cambia al reintentar. */
export interface IncidentVersionResult {
  incidentId: string
  version: number
  status: PublishedIncidentStatus
  reason: string
  instructions: string
  publishedAt: string
}

export interface IncidentVersionSummary extends Omit<IncidentVersionResult, 'incidentId'> { recipientCount: number }

export interface IncidentView {
  id: string
  status: IncidentStatus
  version: number
  reportReason: string
  reportedAt: string
  versions: IncidentVersionSummary[]
}

export interface IncidentCommand {
  action: IncidentAction
  version: number
  reason: string
  instructions: string
  idempotencyKey: string
}

export interface ReportWriter {
  prior(): Promise<IncidentReport | null>
  /** Tiene o tuvo un compromiso con el lote, o es operador de su establecimiento. */
  hasAccess(): Promise<boolean>
  insert(reason: string): Promise<IncidentReport>
}

export interface IncidentState { status: IncidentStatus; version: number }

export interface IncidentWriter {
  isMember(userId: string): Promise<boolean>
  prior(userId: string, key: string): Promise<IncidentVersionResult | null>
  /** Confirma estado, versión y destinatarios juntos, bajo el bloqueo del lote. */
  publish(userId: string, command: IncidentCommand, status: PublishedIncidentStatus): Promise<IncidentVersionResult>
}

export interface IncidentRepository {
  findLot(lotId: string): Promise<{ establishmentId: string } | null>
  findIncident(incidentId: string): Promise<{ establishmentId: string } | null>
  isMember(userId: string, establishmentId: string): Promise<boolean>
  listByLot(lotId: string): Promise<IncidentView[]>
  withReport<T>(userId: string, lotId: string, key: string, operate: (writer: ReportWriter) => Promise<T>): Promise<T>
  withCommand<T>(userId: string, incidentId: string, key: string,
    operate: (state: IncidentState | null, writer: IncidentWriter) => Promise<T>): Promise<T>
}
