import type { IncidentStatus } from '../services/incidents-service'

/** Estado de la incidencia para el operador; «Por revisar» es un reporte sin publicar. */
export const incidentStatusLabels: Record<IncidentStatus, { label: string; tone: 'neutral' | 'success' | 'warning' | 'info' | 'danger' }> = {
  reported: { label: 'Por revisar', tone: 'warning' },
  open: { label: 'Publicada', tone: 'danger' },
  following: { label: 'En seguimiento', tone: 'info' },
  resolved: { label: 'Resuelta', tone: 'success' },
}

/** Gestión de incidencias de un lote, opcionalmente enfocada en una incidencia. */
export const lotIncidentsPath = (lotId: string, incidentId?: string) =>
  `/operador/lotes/${encodeURIComponent(lotId)}/incidencias${incidentId ? `#incidencia-${incidentId}` : ''}`
