// K030 · Infrastructure: inserta el evento de una transición en el outbox con el mismo
// cliente de su transacción (ADR 0012). Si la transición se revierte, el evento también;
// si se confirma, el worker generará su aviso aunque la API caiga después.
import type { NotificationEvent } from '../../domain/notifications.js'
import type { PoolClient } from './pool.js'

/** Datos del lote que muestra el aviso; `lotId` es la PK interna del lote ya bloqueado. */
export async function lotSnapshot(client: PoolClient, lotId: string): Promise<{ id: string; description: string }> {
  const { rows } = await client.query<{ id: string; description: string }>(
    'SELECT public_id::text AS id, description FROM public.lots WHERE id = $1', [lotId])
  if (!rows[0]) throw new Error('El lote del evento no existe')
  return rows[0]
}

/**
 * `subjectId` es la PK interna de la fila que cambió (solicitud o reserva). La unicidad por
 * tipo, fila y versión hace que repetir la misma transición no agregue otro evento.
 */
export async function appendEvent(client: PoolClient, subjectId: string, event: NotificationEvent, at: Date, version = 1): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO public.outbox_events (event_type, subject_id, recipient_user_id, payload, created_at, available_at, version)
     VALUES ($1, $2, $3, $4, $5, $5, $6) ON CONFLICT ON CONSTRAINT outbox_events_subject_key DO NOTHING RETURNING id::text`,
    [event.kind, subjectId, event.recipientUserId, JSON.stringify(event.payload), at, version])
  if (inserted.rows[0]) return inserted.rows[0].id
  const existing = await client.query<{ id: string }>(
    `SELECT id::text FROM public.outbox_events WHERE event_type=$1 AND subject_id=$2 AND version=$3 AND recipient_user_id=$4`,
    [event.kind, subjectId, version, event.recipientUserId])
  return existing.rows[0]!.id
}
