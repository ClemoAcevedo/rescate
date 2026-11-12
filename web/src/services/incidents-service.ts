import { ConnectionError, HttpError, UnexpectedResponseError, request } from './http-client'
import type {
  EstablishmentIncident, EstablishmentIncidentPage, Incident, IncidentReport, IncidentReportRequest, IncidentVersionRequest,
  IncidentVersionResult, IncidentVersionSummary,
} from './openapi'

export type { EstablishmentIncident, EstablishmentIncidentPage, Incident, IncidentReport, IncidentVersionRequest, IncidentVersionResult, IncidentVersionSummary }
export type IncidentStatus = Incident['status']

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const statuses = ['reported', 'open', 'following', 'resolved']
const published = ['open', 'following', 'resolved']

function version(value: unknown): IncidentVersionSummary {
  if (!record(value) || !Number.isSafeInteger(value.version) || (value.version as number) < 1 || !published.includes(String(value.status))
    || !text(value.reason) || !text(value.instructions) || !instant(value.publishedAt) || typeof value.closeLot !== 'boolean'
    || typeof value.lotClosed !== 'boolean' || !count(value.recipientCount) || !text(value.publishedBy) || !record(value.notices)
    || !count(value.notices.pending) || !count(value.notices.generated) || !count(value.notices.read)
    || value.notices.pending + value.notices.generated + value.notices.read !== value.recipientCount) throw new Error('Versión inesperada.')
  // Selección explícita: solo los campos del contrato llegan a la vista.
  return { version: value.version as number, status: value.status as IncidentVersionSummary['status'], reason: value.reason,
    instructions: value.instructions, publishedAt: value.publishedAt, closeLot: value.closeLot, lotClosed: value.lotClosed,
    recipientCount: value.recipientCount, publishedBy: value.publishedBy,
    notices: { pending: value.notices.pending, generated: value.notices.generated, read: value.notices.read } }
}

function incident(value: unknown): Incident {
  if (!record(value) || !text(value.id) || !statuses.includes(String(value.status)) || !count(value.version)
    || !text(value.reportReason) || !instant(value.reportedAt) || !Array.isArray(value.versions)) throw new Error('Incidencia inesperada.')
  const versions = value.versions.map(version)
  if (versions.length !== value.version) throw new Error('Versiones incompletas.')
  return { id: value.id, status: value.status as IncidentStatus, version: value.version, reportReason: value.reportReason,
    reportedAt: value.reportedAt, versions }
}

function establishmentIncident(value: unknown): EstablishmentIncident {
  if (!record(value) || !record(value.lot) || !text(value.lot.id) || !text(value.lot.description)) throw new Error('Lote inesperado.')
  return { ...incident(value), lot: { id: value.lot.id, description: value.lot.description } }
}

function versionResult(value: unknown, incidentId: string): IncidentVersionResult {
  if (!record(value) || typeof value.incidentId !== 'string' || value.incidentId.toLowerCase() !== incidentId.toLowerCase()
    || !Number.isSafeInteger(value.version) || (value.version as number) < 1 || !published.includes(String(value.status))
    || !text(value.reason) || !text(value.instructions) || !instant(value.publishedAt)
    || typeof value.closeLot !== 'boolean' || typeof value.lotClosed !== 'boolean') throw new Error('Resultado inesperado.')
  return { incidentId: value.incidentId, version: value.version as number, status: value.status as IncidentVersionResult['status'],
    reason: value.reason, instructions: value.instructions, publishedAt: value.publishedAt, closeLot: value.closeLot, lotClosed: value.lotClosed }
}

async function send<T>(path: string, parse: (value: unknown) => T,
  options: { method?: 'POST'; body?: object; csrfToken?: string; signal?: AbortSignal } = {}): Promise<T> {
  const result = await request({ path, parse, method: options.method, body: options.body, signal: options.signal,
    headers: options.csrfToken ? { 'X-CSRF-Token': options.csrfToken } : undefined })
  if (result === undefined) throw new UnexpectedResponseError('Respuesta vacía.', undefined)
  return result
}

export function listEstablishmentIncidents(establishmentId: string, query: { status?: IncidentStatus; page: number },
  signal?: AbortSignal): Promise<EstablishmentIncidentPage> {
  const params = new URLSearchParams()
  if (query.status) params.set('status', query.status)
  if (query.page > 1) params.set('page', String(query.page))
  const search = params.size ? `?${params}` : ''
  return send(`/establishments/${encodeURIComponent(establishmentId)}/incidents${search}`, value => {
    if (!record(value) || !Array.isArray(value.items) || value.items.length > 20 || value.page !== query.page
      || typeof value.hasNextPage !== 'boolean') throw new Error('Página inesperada.')
    return { items: value.items.map(establishmentIncident), page: query.page, hasNextPage: value.hasNextPage }
  }, { signal })
}

export function listLotIncidents(lotId: string, signal?: AbortSignal): Promise<Incident[]> {
  return send(`/lots/${encodeURIComponent(lotId)}/incidents`, value => {
    if (!record(value) || !Array.isArray(value.items) || value.items.length > 50) throw new Error('Incidencias inesperadas.')
    return value.items.map(incident)
  }, { signal })
}

/** Registra el problema: no cancela, no cierra el lote ni avisa por sí solo. */
export function reportIncident(lotId: string, body: IncidentReportRequest, csrfToken: string): Promise<IncidentReport> {
  return send(`/lots/${encodeURIComponent(lotId)}/incidents`, value => {
    if (!record(value) || !text(value.id) || typeof value.lotId !== 'string' || value.lotId.toLowerCase() !== lotId.toLowerCase()
      || !text(value.reason) || !instant(value.createdAt)) throw new Error('Reporte inesperado.')
    return { id: value.id, lotId: value.lotId, reason: value.reason, createdAt: value.createdAt }
  }, { method: 'POST', body, csrfToken })
}

/** Publica, actualiza o resuelve; `closeLot` es una decisión explícita aparte. */
export function createIncidentVersion(incidentId: string, body: IncidentVersionRequest, csrfToken: string): Promise<IncidentVersionResult> {
  return send(`/incidents/${encodeURIComponent(incidentId)}/versions`, value => versionResult(value, incidentId),
    { method: 'POST', body, csrfToken })
}

/** Sin respuesta válida el comando pudo aplicarse: se reintenta con la misma clave. */
export function isUncertain(error: unknown): boolean {
  return error instanceof ConnectionError || error instanceof UnexpectedResponseError || error instanceof TypeError
    || (error instanceof HttpError && error.status >= 500)
}

function serverMessage(error: HttpError): string | null {
  const body = error.body
  return record(body) && record(body.error) && typeof body.error.message === 'string' ? body.error.message : null
}

export function incidentError(error: unknown, missing = 'La incidencia o el lote no existe, o no tienes acceso.'): string {
  if (!(error instanceof HttpError)) return 'No fue posible conectar con el servicio. Revisa tu conexión e inténtalo nuevamente.'
  if (error.status === 401) return 'Tu sesión venció. Inicia sesión nuevamente.'
  if (error.status === 403) return 'Tu cuenta no tiene permiso para esta operación o la solicitud fue rechazada por seguridad. Recarga la página.'
  if (error.status === 404) return missing
  if (error.status === 409) return serverMessage(error) ?? 'La incidencia cambió. Actualiza antes de reintentar.'
  if (error.status === 422) return 'Revisa los textos: deben tener entre 1 y 2000 caracteres.'
  if (error.status === 429) return 'Hay demasiadas solicitudes. Espera antes de reintentar.'
  return 'No fue posible completar la operación. Inténtalo nuevamente.'
}
