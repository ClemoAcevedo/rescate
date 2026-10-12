// K027 · Infrastructure: asienta la cola FIFO de un lote ya bloqueado (ADR 0006, ADR 0010).
// Registra las ofertas vencidas, cierra la cola de un lote que dejó de asignar y ofrece lo
// libre a quienes esperan según el plan de Domain. Se llama con el cliente de la transacción
// que acaba de liberar packs (cancelar, rechazar, vencer) o de leer el inventario.
import { isAssignable, planOffers } from '../../domain/waitlist.js'
import type { PoolClient } from './pool.js'

/**
 * Contrasta cada contador con los registros que lo respaldan (anexos B p. 4): R con las
 * reservas confirmadas, E con las entregas y O con las ofertas vigentes. `l` es el lote.
 */
export const lotReconciledSql = `l.reserved_quantity = COALESCE((SELECT sum(c.quantity) FROM public.commitments c
    WHERE c.lot_id = l.id AND c.status = 'confirmed'), 0)
  AND l.delivered_quantity = COALESCE((SELECT sum(d.quantity) FROM public.deliveries d
    JOIN public.commitments c ON c.id = d.commitment_id WHERE c.lot_id = l.id), 0)
  AND l.offered_quantity = COALESCE((SELECT sum(w.offered_quantity) FROM public.waitlist_entries w
    WHERE w.lot_id = l.id AND w.status = 'offered'), 0)`

/** Devuelve cuántas solicitudes se cerraron por vencimiento. `at` es el reloj de la base tras el bloqueo. */
export async function settleQueue(client: PoolClient, lotId: string, at: Date): Promise<number> {
  const found = await client.query<{ status: string; pickup_ends_at: Date }>(
    'SELECT status::text, pickup_ends_at FROM public.lots WHERE id = $1', [lotId])
  const lot = found.rows[0]
  if (!lot) return 0
  const assignable = isAssignable({ status: lot.status, pickupEndsAt: lot.pickup_ends_at }, at)

  // Una oferta vence a su hora; si el lote dejó de asignar, termina con él.
  const lapsed = await client.query<{ offered_quantity: number }>(
    `UPDATE public.waitlist_entries SET status = 'expired', ended_at = LEAST(offer_expires_at, $2)
     WHERE lot_id = $1 AND status = 'offered' AND (offer_expires_at <= $2 OR NOT $3::boolean)
     RETURNING offered_quantity`, [lotId, at, assignable])
  let closed = lapsed.rowCount ?? 0
  const released = lapsed.rows.reduce((total, row) => total + row.offered_quantity, 0)
  // O → F si el lote sigue asignando (F se deriva), O → X si ya no (ADR 0002).
  if (released > 0) await client.query(
    `UPDATE public.lots SET offered_quantity = offered_quantity - $2,
       expired_quantity = expired_quantity + CASE WHEN $3::boolean THEN 0 ELSE $2 END WHERE id = $1`,
    [lotId, released, assignable])

  if (!assignable) {
    // La espera no posee packs: al cerrar el lote simplemente termina, sin prioridad ni reingreso.
    const waiting = await client.query(
      `UPDATE public.waitlist_entries SET status = 'expired', ended_at = LEAST($2::timestamptz, $3)
       WHERE lot_id = $1 AND status = 'waiting'`, [lotId, lot.pickup_ends_at, at])
    return closed + (waiting.rowCount ?? 0)
  }

  const state = await client.query<{ free: number; reconciled: boolean }>(
    `SELECT l.free_quantity AS free, ${lotReconciledSql} AS reconciled FROM public.lots l WHERE l.id = $1`, [lotId])
  // Una discrepancia bloquea nuevas asignaciones, también las ofertas, hasta su revisión.
  if (!state.rows[0]!.reconciled || state.rows[0]!.free <= 0) return closed
  const queue = await client.query<{ id: string; requested_quantity: number }>(
    `SELECT id::text, requested_quantity FROM public.waitlist_entries
     WHERE lot_id = $1 AND status = 'waiting' ORDER BY id`, [lotId])
  const plan = planOffers(state.rows[0]!.free,
    queue.rows.map(row => ({ id: row.id, requestedQuantity: row.requested_quantity })), at, lot.pickup_ends_at)
  let offered = 0
  for (const offer of plan) {
    const updated = await client.query(
      `UPDATE public.waitlist_entries SET status = 'offered', offered_quantity = $2, offered_at = $3,
         offer_expires_at = $4 WHERE id = $1 AND status = 'waiting'`, [offer.id, offer.quantity, at, offer.expiresAt])
    if (updated.rowCount !== 1) throw new Error('La oferta no se asignó a la solicitud en espera')
    offered += offer.quantity
  }
  // F → O: los CHECK del lote rechazan sobreasignación aunque el plan fallara.
  if (offered > 0) await client.query(
    'UPDATE public.lots SET offered_quantity = offered_quantity + $2 WHERE id = $1', [lotId, offered])
  return closed
}
