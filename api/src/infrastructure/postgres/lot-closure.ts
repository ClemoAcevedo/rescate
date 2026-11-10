// Protocolo común de cierre sobre un lote ya bloqueado. Conserva las entregas E.
import type { PoolClient } from './pool.js'
import { appendEvent, lotSnapshot } from './outbox.js'
import { settleQueue } from './waitlist-queue.js'

export async function closeLot(client: PoolClient, lotId: string, status: 'withdrawn' | 'expired', at: Date,
  notifyTransitions = true): Promise<void> {
  await client.query("UPDATE public.lots SET status=$2, closed_at=$3, paused_at=NULL WHERE id=$1", [lotId, status, at])
  const ended = await client.query<{ id: string; public_id: string; user_id: string; quantity: number }>(
    `UPDATE public.commitments SET status=$3, ended_at=$2, pickup_code_ciphertext=NULL
     WHERE lot_id=$1 AND status='confirmed' RETURNING id::text, public_id::text, user_id::text, quantity`,
    [lotId, at, status === 'expired' ? 'expired' : 'cancelled'])
  const packs = ended.rows.reduce((sum, row) => sum + row.quantity, 0)
  await client.query(`UPDATE public.lots SET reserved_quantity=reserved_quantity-$2,
    expired_quantity=expired_quantity+$2 WHERE id=$1`, [lotId, packs])
  if (notifyTransitions && status === 'withdrawn' && ended.rows.length) {
    const snapshot = await lotSnapshot(client, lotId)
    for (const row of ended.rows) await appendEvent(client, row.id, {
      kind: 'reservation_cancelled', recipientUserId: row.user_id,
      payload: { lot: snapshot, quantity: row.quantity, waitlistEntryId: null, reservationId: row.public_id, offerExpiresAt: null },
    }, at)
  }
  // El cierre por incidencia comunica su propia versión por tandas; no duplica cancelaciones/ofertas.
  await settleQueue(client, lotId, at, notifyTransitions)
  await client.query('UPDATE public.lots SET expired_quantity=expired_quantity+free_quantity WHERE id=$1', [lotId])
}
