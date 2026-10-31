import { randomUUID } from 'node:crypto'
import type { LotManagementRepository, LotManagementView, LotOperation, StoredCommand } from '../../application/lots/management.js'
import type { LotCommand, ManagedLot } from '../../domain/lot-management.js'
import { lockIntent, lockLot } from './lot-lock.js'
import { withTransaction } from './pool.js'
import type { Pool, PoolClient } from './pool.js'
import { lotReconciledSql, settleQueue } from './waitlist-queue.js'
import { appendEvent, lotSnapshot } from './outbox.js'

type Db = Pick<PoolClient, 'query'>
async function readView(db: Db, lotId: string): Promise<LotManagementView> {
  const { rows } = await db.query<ManagedLot>(`SELECT l.status, l.version, l.paused_at IS NOT NULL AS paused,
    l.free_quantity AS "freeQuantity", l.offered_quantity AS "offeredQuantity", l.reserved_quantity AS "reservedQuantity",
    l.delivered_quantity AS "deliveredQuantity", l.expired_quantity AS "unassignableQuantity"
    FROM public.lots l WHERE l.public_id = $1`, [lotId])
  if (!rows[0]) throw new Error('El lote autorizado dejó de existir')
  const history = await db.query<LotOperation>(`SELECT o.public_id::text AS id, o.action, o.quantity, o.reason,
    to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
    (o.result->>'version')::integer AS version FROM public.lot_operations o JOIN public.lots l ON l.id = o.lot_id
    WHERE l.public_id = $1 ORDER BY o.id DESC LIMIT 20`, [lotId])
  return { ...rows[0], history: history.rows }
}
async function member(db: Db, userId: string, establishmentId: string) {
  return (await db.query('SELECT 1 FROM public.memberships WHERE user_id=$1 AND establishment_id=$2', [userId, establishmentId])).rowCount === 1
}

export function createLotManagementRepository(pool: Pool): LotManagementRepository {
  return {
    async find(lotId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lotId)) return null
      const { rows } = await pool.query<{ establishmentId: string }>(
        'SELECT establishment_id::text AS "establishmentId" FROM public.lots WHERE public_id=$1', [lotId])
      return rows[0] ?? null
    },
    isMember: (userId, establishmentId) => member(pool, userId, establishmentId),
    read: lotId => readView(pool, lotId),
    async withCommand(userId, lotId, key, operate) {
      return withTransaction(pool, async client => {
        await lockIntent(client, 'lot_management', userId, key)
        const locked = await lockLot(client, lotId)
        const unavailable = async (): Promise<never> => { throw new Error('No se escribe sin lote') }
        if (!locked) return operate(null, { settle: unavailable, isMember: unavailable, prior: unavailable, apply: unavailable })
        const { rows: [row] } = await client.query<{ establishment_id: string; pickup_ends_at: Date; reconciled: boolean }>(
          `SELECT l.establishment_id::text, l.pickup_ends_at, ${lotReconciledSql} AS reconciled FROM public.lots l WHERE l.id=$1`, [locked.lotId])
        const view = await readView(client, lotId)
        return operate({ lot: view, establishmentId: row!.establishment_id, pickupEndsAt: row!.pickup_ends_at,
          at: locked.at, reconciled: row!.reconciled }, {
          async settle() {
            await settleQueue(client, locked.lotId, locked.at)
            const lot = await readView(client, lotId)
            const checked = await client.query<{ reconciled: boolean }>(
              `SELECT ${lotReconciledSql} AS reconciled FROM public.lots l WHERE l.id=$1`, [locked.lotId])
            return { lot, establishmentId: row!.establishment_id, pickupEndsAt: row!.pickup_ends_at,
              at: locked.at, reconciled: checked.rows[0]!.reconciled }
          },
          isMember: actorId => member(client, actorId, row!.establishment_id),
          async prior(actorId, intent) {
            const { rows } = await client.query<{ lot_id: string; action: LotCommand['action']; quantity: number | null;
              reason: string; expected_version: number; result: LotManagementView }>(`SELECT l.public_id::text AS lot_id,
              o.action, o.quantity, o.reason, o.expected_version, o.result FROM public.lot_operations o
              JOIN public.lots l ON l.id=o.lot_id WHERE o.user_id=$1 AND o.idempotency_key=$2`, [actorId, intent])
            const found = rows[0]
            if (!found) return null
            return { lotId: found.lot_id, command: { action: found.action, reason: found.reason, version: found.expected_version,
              idempotencyKey: intent, ...(found.quantity === null ? {} : { quantity: found.quantity }) }, result: found.result } satisfies StoredCommand
          },
          async apply(actorId, command) {
            // Los efectos, el historial y el resultado del reintento se confirman juntos.
            if (command.action === 'reduce_stock') await client.query(
              'UPDATE public.lots SET expired_quantity=expired_quantity+$2 WHERE id=$1', [locked.lotId, command.quantity])
            if (command.action === 'pause' || command.action === 'resume') await client.query(
              'UPDATE public.lots SET paused_at=$2 WHERE id=$1', [locked.lotId, command.action === 'pause' ? locked.at : null])
            if (command.action === 'withdraw') {
              await client.query("UPDATE public.lots SET status='withdrawn', closed_at=$2, paused_at=NULL WHERE id=$1", [locked.lotId, locked.at])
              const cancelled = await client.query<{ id: string; public_id: string; user_id: string; quantity: number }>(
                `UPDATE public.commitments SET status='cancelled', ended_at=$2, pickup_code_ciphertext=NULL
                 WHERE lot_id=$1 AND status='confirmed' RETURNING id::text, public_id::text, user_id::text, quantity`, [locked.lotId, locked.at])
              const packs = cancelled.rows.reduce((sum, reservation) => sum+reservation.quantity, 0)
              await client.query(`UPDATE public.lots SET reserved_quantity=reserved_quantity-$2,
                expired_quantity=expired_quantity+$2 WHERE id=$1`, [locked.lotId, packs])
              const snapshot = await lotSnapshot(client, locked.lotId)
              for (const reservation of cancelled.rows) await appendEvent(client, reservation.id, {
                kind: 'reservation_cancelled', recipientUserId: reservation.user_id,
                payload: { lot: snapshot, quantity: reservation.quantity, waitlistEntryId: null,
                  reservationId: reservation.public_id, offerExpiresAt: null },
              }, locked.at)
            }
            await settleQueue(client, locked.lotId, locked.at)
            if (command.action === 'withdraw') await client.query(
              'UPDATE public.lots SET expired_quantity=expired_quantity+free_quantity WHERE id=$1', [locked.lotId])
            await client.query('UPDATE public.lots SET version=version+1, updated_at=$2 WHERE id=$1', [locked.lotId, locked.at])
            const current = await readView(client, lotId)
            const operation: LotOperation = { id: randomUUID(), action: command.action, quantity: command.quantity ?? null,
              reason: command.reason, createdAt: locked.at.toISOString(), version: current.version }
            const result = { ...current, history: [operation, ...current.history].slice(0, 20) }
            await client.query(`INSERT INTO public.lot_operations (public_id,lot_id,user_id,idempotency_key,action,
              quantity,reason,expected_version,result,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [operation.id, locked.lotId, actorId, command.idempotencyKey, command.action, command.quantity ?? null,
                command.reason, command.version, JSON.stringify(result), locked.at])
            return result
          },
        })
      })
    },
  }
}
