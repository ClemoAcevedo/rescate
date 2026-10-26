// K036 · Infrastructure: latido del worker, salud de la API y tareas pendientes o en error
// (anexos H p. 22). Solo lee y escribe el latido; no decide transiciones. Usa el reloj de
// la base, como los vencimientos (ADR 0006).
import type { Backlog, FailedTask, Health, Operations } from '../../application/operations/ports.js'
import { OUTBOX_MAX_ATTEMPTS } from '../../domain/notifications.js'
import { DUE_LOTS } from './expiry-repository.js'
import type { Pool } from './pool.js'

/** Sin un ciclo exitoso en este plazo, la salud informa el worker detenido. */
const WORKER_STALE_SECONDS = 60
/** Tope de la salud: con la red colgada, statement_timeout de la base no llega a actuar. */
const HEALTH_TIMEOUT_MS = 3000

/**
 * En error, sin reintento propio: lote con los intentos agotados y sin concesión vigente
 * (el último intento ya terminó o su worker murió), aviso `failed` o `pending` con los
 * intentos agotados y la concesión vencida (lo que el próximo reclamo marca `failed`), y
 * foto rechazada por fallos del worker. Todo lo demás vencido o pendiente es demora.
 */
const LOT_FAILED = `l.expiry_attempts >= $1
  AND (l.expiry_claimed_until IS NULL OR l.expiry_claimed_until <= clock_timestamp())`
// Sin concesión (claimed_until NULL), el reclamo lo vuelve a tomar: es pendiente, no NULL.
const EVENT_FAILED = `COALESCE(e.status = 'failed' OR e.status = 'pending' AND e.attempts >= $2
  AND e.claimed_until <= clock_timestamp(), false)`

export function createOperations(pool: Pool, maxExpiryAttempts: number): Operations {
  // Una sola consulta de salud a la vez, hasta que termine aunque su respuesta ya haya
  // vencido: con la base colgada, una comprobación cada 3 s no ocupa una conexión nueva.
  let probe: Promise<boolean | null> | null = null
  return {
    async recordWorkerCycle() {
      await pool.query(`INSERT INTO public.worker_heartbeat (last_cycle_at) VALUES (clock_timestamp())
        ON CONFLICT (id) DO UPDATE SET last_cycle_at = EXCLUDED.last_cycle_at`)
    },

    async checkHealth(): Promise<Health> {
      probe ??= pool.query<{ alive: boolean | null }>(`SELECT (SELECT last_cycle_at > clock_timestamp()
        - $1 * interval '1 second' FROM public.worker_heartbeat) AS alive`, [WORKER_STALE_SECONDS])
        .then(({ rows }) => rows[0]!.alive).finally(() => { probe = null })
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('health_timeout')), HEALTH_TIMEOUT_MS) })
      try {
        return { database: 'ok', worker: await Promise.race([probe, timeout]) ? 'ok' : 'stopped' }
      } catch (error) {
        // Base sin la migración K036 (42P01): responde, pero aún no hay latido que leer.
        if ((error as { code?: unknown }).code === '42P01') return { database: 'ok', worker: 'unknown' }
        // El error puede traer host o credenciales: la salud solo dice que no hay base.
        return { database: 'unavailable', worker: 'unknown' }
      } finally {
        clearTimeout(timer)
      }
    },

    async readBacklog(): Promise<Backlog[]> {
      const { rows } = await pool.query<Backlog>(
        `WITH lots AS (
           SELECT d.due_at FROM (${DUE_LOTS}) d JOIN public.lots l ON l.id = d.lot_id WHERE NOT (${LOT_FAILED})),
         events AS (
           SELECT e.created_at, ${EVENT_FAILED} AS failed FROM public.outbox_events e WHERE e.status IN ('pending', 'failed')),
         queues AS (
           SELECT 1 AS position, 'expiries' AS queue, count(*)::int AS pending, min(due_at) AS oldest,
             (SELECT count(*)::int FROM public.lots l WHERE ${LOT_FAILED}) AS failed FROM lots
           UNION ALL
           SELECT 2, 'notifications', count(*) FILTER (WHERE NOT failed)::int,
             min(created_at) FILTER (WHERE NOT failed), count(*) FILTER (WHERE failed)::int FROM events
           UNION ALL
           SELECT 3, 'photos', count(*) FILTER (WHERE status = 'pending')::int,
             min(created_at) FILTER (WHERE status = 'pending'), count(*) FILTER (WHERE status = 'rejected')::int
           FROM public.lot_photos WHERE status = 'pending' OR status = 'rejected' AND rejection_reason = 'processing_failed')
         SELECT queue, pending, floor(extract(epoch FROM clock_timestamp() - oldest))::int AS "delaySeconds", failed
         FROM queues ORDER BY position`, [maxExpiryAttempts, OUTBOX_MAX_ATTEMPTS])
      return rows
    },

    async listFailedTasks(): Promise<FailedTask[]> {
      // Las primeras 20 de cada cola; el conteo completo está en readBacklog.
      const { rows } = await pool.query<FailedTask>(
        `(SELECT 'expiries' AS queue, l.public_id::text AS id, l.expiry_attempts AS attempts, NULL AS code
          FROM public.lots l WHERE ${LOT_FAILED} ORDER BY l.id LIMIT 20)
         UNION ALL
         (SELECT 'notifications', e.id::text, e.attempts, CASE WHEN e.status = 'failed' THEN e.last_error ELSE 'LEASE_EXPIRED' END
          FROM public.outbox_events e WHERE ${EVENT_FAILED} ORDER BY e.id LIMIT 20)
         UNION ALL
         (SELECT 'photos', public_id::text, attempts, rejection_reason FROM public.lot_photos
          WHERE status = 'rejected' AND rejection_reason = 'processing_failed' ORDER BY id LIMIT 20)`,
        [maxExpiryAttempts, OUTBOX_MAX_ATTEMPTS])
      return rows
    },
  }
}
