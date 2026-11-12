import { useRef, useState, type FormEvent } from 'react'
import { incidentError, isUncertain, reportIncident } from '../../services/incidents-service'
import type { IncidentReport } from '../../services/incidents-service'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/FormControls'
import { FormField } from '../ui/FormField'

/**
 * Registra un problema del lote para que el establecimiento lo revise. No cancela reservas,
 * no cierra el lote ni avisa por sí solo; una respuesta perdida se reintenta con la misma clave.
 */
export function ReportIncidentForm({ lotId, csrfToken, label, hint, onReported }: {
  lotId: string; csrfToken: string; label: string; hint: string; onReported: (report: IncidentReport) => void
}) {
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState<{ reason: string; idempotencyKey: string } | null>(null)
  const busy = useRef(false)

  async function send(intent: { reason: string; idempotencyKey: string }) {
    if (busy.current) return
    busy.current = true; setPending(true); setError(null)
    try {
      const report = await reportIncident(lotId, intent, csrfToken)
      setUncertain(null); setReason('')
      onReported(report)
    } catch (reason) {
      if (isUncertain(reason)) {
        setUncertain(intent)
        setError('No se pudo confirmar el envío. Reintentar envía el mismo reporte y no lo duplica.')
      } else {
        setUncertain(null)
        setError(incidentError(reason, 'No puedes reportar este lote: solo quien tuvo una reserva o una espera en él, o su establecimiento.'))
      }
    } finally { busy.current = false; setPending(false) }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!reason.trim()) { setError('Describe el problema antes de enviarlo.'); return }
    void send({ reason: reason.trim(), idempotencyKey: crypto.randomUUID() })
  }

  return (
    <form className="incident-form" onSubmit={submit} aria-busy={pending}>
      {error && <Alert tone="warning" role="alert">{error}</Alert>}
      {uncertain
        ? <Button disabled={pending} loading={pending} onClick={() => { void send(uncertain) }}>Reintentar el mismo reporte</Button>
        : <>
          <FormField label={label} required hint={hint}>{control => (
            <Textarea {...control} rows={4} maxLength={2000} value={reason} disabled={pending} onChange={event => setReason(event.target.value)} />
          )}</FormField>
          <Button type="submit" loading={pending} disabled={pending}>Enviar reporte</Button>
        </>}
    </form>
  )
}
