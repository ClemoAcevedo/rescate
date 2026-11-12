import { formatInstant } from '../../format/date-time'
import type { IncidentVersionSummary } from '../../services/incidents-service'
import { incidentStatusLabels } from '../../incidents/incident-labels'
import { Badge } from '../ui/Badge'

const people = (count: number) => `${count} ${count === 1 ? 'persona' : 'personas'}`

/** Avisos de una versión por destinatario, sin identificar a nadie. */
export function NoticeCounts({ version }: { version: IncidentVersionSummary }) {
  const { pending, generated, read } = version.notices
  return (
    <dl className="incident-notices" aria-label={`Avisos de la versión ${version.version} a ${people(version.recipientCount)}`}>
      <div><dt>Pendientes</dt><dd>{pending}</dd></div>
      <div><dt>Generados sin leer</dt><dd>{generated}</dd></div>
      <div><dt>Leídos</dt><dd>{read}</dd></div>
    </dl>
  )
}

/** Cada versión conserva motivo, instrucciones, responsable, fecha y decisión de cierre. */
export function IncidentHistory({ versions, timeZone }: { versions: IncidentVersionSummary[]; timeZone: string }) {
  if (versions.length === 0) return <p className="incident__empty">Aún no se publica: nadie ha recibido avisos.</p>
  return (
    <ol className="incident-versions">
      {[...versions].reverse().map(version => (
        <li key={version.version} className="incident-version">
          <div className="incident-version__head">
            <Badge tone={incidentStatusLabels[version.status].tone}>{incidentStatusLabels[version.status].label}</Badge>
            <span>Versión {version.version}</span>
          </div>
          <p className="incident-version__meta">
            Publicó <strong>{version.publishedBy}</strong> el <time dateTime={version.publishedAt}>{formatInstant(version.publishedAt, timeZone)}</time>
          </p>
          <dl className="incident-version__texts">
            <div><dt>Motivo</dt><dd>{version.reason}</dd></div>
            <div><dt>Instrucciones</dt><dd>{version.instructions}</dd></div>
          </dl>
          {version.closeLot
            ? <p className="incident-version__closure">Con esta versión se decidió cerrar el lote.</p>
            : version.lotClosed && <p className="incident-version__closure">El lote ya estaba cerrado al publicarla.</p>}
          <p className="incident-version__recipients">Avisos a {people(version.recipientCount)}:</p>
          <NoticeCounts version={version} />
        </li>
      ))}
    </ol>
  )
}
