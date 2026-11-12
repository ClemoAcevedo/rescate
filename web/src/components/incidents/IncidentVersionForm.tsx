import { useRef, useState, type FormEvent } from 'react'
import { createIncidentVersion, incidentError, isUncertain } from '../../services/incidents-service'
import type { Incident, IncidentVersionRequest, IncidentVersionResult } from '../../services/incidents-service'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Select, Textarea } from '../ui/FormControls'
import { FormField } from '../ui/FormField'

const MAX_TEXT = 2000
const actionLabels: Record<IncidentVersionRequest['action'], string> = {
  publish: 'Publicar incidencia', update: 'Publicar actualización', resolve: 'Resolver incidencia',
}

/**
 * Publicar, actualizar y resolver crean una versión que avisa a los vinculados. Cerrar el lote
 * es una decisión aparte que exige confirmación; una respuesta perdida se reintenta con la misma clave.
 */
export function IncidentVersionForm({ incident, lotOpen, csrfToken, onPublished }: {
  incident: Incident; lotOpen: boolean; csrfToken: string; onPublished: (result: IncidentVersionResult) => void
}) {
  const latest = incident.versions.at(-1)
  const actions: IncidentVersionRequest['action'][] = incident.status === 'reported' ? ['publish'] : ['update', 'resolve']
  const [action, setAction] = useState(actions[0]!)
  const [reason, setReason] = useState(latest?.reason ?? incident.reportReason)
  const [instructions, setInstructions] = useState(latest?.instructions ?? '')
  const [closeLot, setCloseLot] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState<IncidentVersionRequest | null>(null)
  const busy = useRef(false)

  async function execute(retry?: IncidentVersionRequest) {
    if (busy.current) return
    const command = retry ?? { action, version: incident.version, reason: reason.trim(), instructions: instructions.trim(),
      idempotencyKey: crypto.randomUUID(), ...(lotOpen && closeLot ? { closeLot: true } : {}) }
    busy.current = true; setPending(true); setConfirming(false)
    try {
      const result = await createIncidentVersion(incident.id, command, csrfToken)
      setUncertain(null); setCloseLot(false); setMessage(null)
      // Quien muestra la página anuncia el resultado y vuelve a consultar; el formulario se reinicia.
      onPublished(result)
    } catch (error) {
      if (isUncertain(error)) {
        setUncertain(command)
        setMessage('No se pudo confirmar el resultado. Reintentar la misma operación conserva su clave y no publica dos veces.')
      } else {
        setUncertain(null)
        setMessage(incidentError(error))
      }
    } finally { busy.current = false; setPending(false) }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!reason.trim() || !instructions.trim()) { setMessage('Indica el motivo y las instrucciones para quienes reciben el aviso.'); return }
    if (lotOpen && closeLot) setConfirming(true)
    else void execute()
  }

  if (incident.status === 'resolved') return <p className="incident__final">La incidencia está resuelta: no admite nuevas versiones.</p>
  return (
    <form className="incident-form" onSubmit={submit} aria-busy={pending}>
      {message && <Alert tone="warning" role="alert">{message}</Alert>}
      {uncertain ? <Button disabled={pending} loading={pending} onClick={() => { void execute(uncertain) }}>Reintentar la misma operación</Button> : <>
        {actions.length > 1 && <FormField label="Acción">{control => (
          <Select {...control} value={action} disabled={pending} onChange={event => setAction(event.target.value as typeof action)}>
            <option value="update">Publicar una actualización (sigue en seguimiento)</option>
            <option value="resolve">Resolver la incidencia (no admite más versiones)</option>
          </Select>
        )}</FormField>}
        <FormField label="Motivo" required hint="Lo leen todas las personas vinculadas al lote.">{control => (
          <Textarea {...control} rows={3} maxLength={MAX_TEXT} value={reason} disabled={pending} onChange={event => setReason(event.target.value)} />
        )}</FormField>
        <FormField label="Instrucciones" required hint="Qué deben hacer quienes reservaron o retiraron packs.">{control => (
          <Textarea {...control} rows={3} maxLength={MAX_TEXT} value={instructions} disabled={pending} onChange={event => setInstructions(event.target.value)} />
        )}</FormField>
        {lotOpen
          ? <label className="consent-check incident-form__close">
            <input type="checkbox" checked={closeLot} disabled={pending} onChange={event => { setCloseLot(event.target.checked); setConfirming(false) }} />
            <span>Cerrar el lote con esta versión: cancela las reservas pendientes, invalida sus códigos y termina ofertas y espera. Las entregas se conservan.</span>
          </label>
          : <p className="incident-form__note">El lote ya está cerrado: la versión solo avisa.</p>}
        {confirming
          ? <Alert tone="warning" role="alert">
            <p>¿Confirmas publicar y cerrar el lote? No se puede deshacer, ni siquiera al resolver.</p>
            <div className="incident-form__actions">
              <Button variant="danger" disabled={pending} onClick={() => { void execute() }}>Confirmar y cerrar el lote</Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>Volver</Button>
            </div>
          </Alert>
          : <Button type="submit" loading={pending} disabled={pending}>{actionLabels[action]}</Button>}
      </>}
    </form>
  )
}
