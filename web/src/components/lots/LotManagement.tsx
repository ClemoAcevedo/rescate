import { useEffect, useRef, useState } from 'react'
import { Alert } from '../ui/Alert'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { FormField } from '../ui/FormField'
import { Input, Select, Textarea } from '../ui/FormControls'
import { ConnectionError, UnexpectedResponseError, LotRequestError, getLotManagement, manageLot } from '../../services/lots-service'
import type { LotManagementRequest, LotManagementResponse } from '../../services/lots-service'

const labels: Record<LotManagementRequest['action'], string> = {
  reduce_stock: 'Descontar stock', pause: 'Pausar publicación', resume: 'Reactivar publicación', withdraw: 'Retirar publicación',
}
export function LotManagement({ lotId, version, csrfToken, pickupEndsAt, onChanged }: {
  lotId: string; version: number; csrfToken: string; pickupEndsAt: string; onChanged: () => void
}) {
  const [openedAt] = useState(() => Date.now())
  const [state, setState] = useState<LotManagementResponse | null>(null)
  const [action, setAction] = useState<LotManagementRequest['action']>('reduce_stock')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [pending, setPending] = useState(false)
  const [uncertain, setUncertain] = useState<LotManagementRequest | null>(null)
  const [confirming, setConfirming] = useState(false)
  const busy = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    getLotManagement(lotId, controller.signal).then(setState).catch(() => {
      if (!controller.signal.aborted) setMessage({ text: 'No fue posible consultar el inventario. Usa Actualizar inventario.', error: true })
    })
    return () => controller.abort()
  }, [lotId, version])
  async function refresh() {
    if (busy.current) return
    busy.current = true; setPending(true)
    try { setState(await getLotManagement(lotId)); setMessage({ text: 'Inventario actualizado. Si una operación quedó sin respuesta, reintenta la misma operación para comprobar su resultado.', error: false }) }
    catch { setMessage({ text: 'No fue posible actualizar el inventario.', error: true }) }
    finally { busy.current = false; setPending(false) }
  }
  async function execute(retry?: LotManagementRequest) {
    if (busy.current || !state) return
    const command = retry ?? { action, version: state.version, idempotencyKey: crypto.randomUUID(), reason: reason.trim(),
      ...(action === 'reduce_stock' ? { quantity: Number(quantity) } : {}) }
    if (!retry && (!command.reason || command.reason.length > 500 || (command.action === 'reduce_stock'
        && (!Number.isSafeInteger(command.quantity) || command.quantity! < 1 || command.quantity! > state.freeQuantity)))) {
      setMessage({ text: 'Indica un motivo y, para descontar stock, una cantidad entera entre 1 y las unidades libres.', error: true }); return
    }
    busy.current = true; setPending(true); setConfirming(false)
    try {
      const result = await manageLot(lotId, command, csrfToken)
      setUncertain(null); setReason(''); setQuantity(''); setAction('reduce_stock'); setState(result)
      setMessage({ text: `${labels[command.action]}: operación confirmada.`, error: false })
      // El resultado reproducido puede ser histórico; consultar el estado actual.
      try { setState(await getLotManagement(lotId)) }
      catch { setMessage({ text: 'Operación confirmada. Actualiza el inventario para consultar el estado actual.', error: false }); setState(null) }
      onChanged()
    } catch (error) {
      if (error instanceof ConnectionError || error instanceof UnexpectedResponseError
          || error instanceof LotRequestError && error.status >= 500) {
        setUncertain(command)
        setMessage({ text: 'No se pudo confirmar el resultado. Reintentar la misma operación conserva su clave y evita descontar o cerrar dos veces.', error: true })
      } else {
        setUncertain(null)
        setMessage({ text: error instanceof LotRequestError ? error.error.message : 'No fue posible completar la operación.', error: true })
      }
    } finally { busy.current = false; setPending(false) }
  }
  const open = state?.status === 'published' && openedAt < Date.parse(pickupEndsAt)
  return <Card as="section" tone="sunken" className="lot-photos" aria-labelledby="lot-management-title" aria-busy={pending}>
    <div className="lot-photos__header"><h2 id="lot-management-title">Gestionar disponibilidad</h2>
      {state?.paused && <Badge tone="warning">Publicación pausada</Badge>}</div>
    <p>Ofrece el lote solo hasta el cierre de retiro indicado. Al cerrar, las unidades pendientes dejan de estar disponibles.</p>
    {message && <Alert tone={message.error ? 'warning' : 'success'} role={message.error ? 'alert' : 'status'}>{message.text}</Alert>}
    <Button variant="secondary" disabled={pending} onClick={() => { void refresh() }}>Actualizar inventario</Button>
    {state && <><p>Libres: <strong>{state.freeQuantity}</strong> · Ofrecidos: {state.offeredQuantity} · Reservados: {state.reservedQuantity} · Entregados: {state.deliveredQuantity} · No asignables: {state.unassignableQuantity}</p>
      {uncertain ? <Button disabled={pending} onClick={() => { void execute(uncertain) }}>Reintentar la misma operación</Button>
        : open && <form className="lot-form" onSubmit={event => { event.preventDefault(); if (action === 'withdraw') setConfirming(true); else void execute() }}>
          <FormField label="Acción">{control => <Select {...control} value={action} disabled={pending} onChange={event => { setAction(event.target.value as typeof action); setConfirming(false) }}>
            <option value="reduce_stock">Descontar venta en el local o merma</option>
            <option value={state.paused ? 'resume' : 'pause'}>{state.paused ? labels.resume : labels.pause}</option>
            <option value="withdraw">Retirar publicación definitivamente</option>
          </Select>}</FormField>
          {action === 'reduce_stock' && <FormField label="Packs que ya no están disponibles" required hint={`Solo puedes descontar los ${state.freeQuantity} packs libres.`}>
            {control => <Input {...control} type="number" min="1" max={state.freeQuantity} step="1" value={quantity} onChange={event => setQuantity(event.target.value)} disabled={pending} required />}</FormField>}
          <FormField label="Motivo" required>{control => <Textarea {...control} maxLength={500} required value={reason} disabled={pending} onChange={event => setReason(event.target.value)} />}</FormField>
          <p>{action === 'withdraw' ? 'Se cancelarán las reservas pendientes, se invalidarán sus códigos y terminarán las ofertas y la espera. Las entregas anteriores se conservan. Esta acción no se puede deshacer.'
            : 'La pausa conserva reservas, ofertas vigentes y posiciones de espera; impide nuevas asignaciones. Reactivar no amplía los plazos.'}</p>
          {confirming ? <Alert tone="warning" role="alert"><p>¿Confirmas el retiro definitivo de esta publicación?</p>
            <Button variant="danger" disabled={pending} onClick={() => { void execute() }}>Confirmar retiro de publicación</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Volver</Button></Alert>
            : <Button type="submit" disabled={pending}>{labels[action]}</Button>}
        </form>}
      {state.history.length > 0 && <><h3>Últimas operaciones</h3><ul>{state.history.map(item => <li key={item.id}>
        {labels[item.action]}{item.quantity === null ? '' : `: ${item.quantity} packs`} · {item.reason} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('es-CL')}</time>
      </li>)}</ul></>}
    </>}
  </Card>
}
