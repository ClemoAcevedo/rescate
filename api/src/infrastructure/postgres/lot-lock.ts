// K021 · Infrastructure: bloqueo común de los comandos que mueven inventario
// (reserva, y después cancelación, ofertas y retiro). Se usa dentro de
// withTransaction con el mismo cliente; los locks se liberan con COMMIT/ROLLBACK.
import type { PoolClient } from "./pool.js"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Espera máxima por un bloqueo (anexos H p. 20); al vencer, 55P03 revierte todo. */
async function limitLockWait(client: PoolClient): Promise<void> {
  await client.query("SET LOCAL lock_timeout = '2s'")
}

/**
 * Serializa una intención por actor y clave antes de leer su resultado previo.
 * El ámbito separa los espacios de claves de cada comando.
 */
export async function lockIntent(client: PoolClient, scope: string, userId: string, key: string): Promise<void> {
  await limitLockWait(client)
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${scope}:${userId}:${key}`])
}

/**
 * Bloquea el lote y luego lee el reloj de PostgreSQL. El instante es posterior a
 * la espera, así que plazos y estado se evalúan con lo vigente al decidir.
 */
export async function lockLot(client: PoolClient, publicId: string): Promise<{ lotId: string; at: Date } | null> {
  if (!UUID_PATTERN.test(publicId)) return null
  await limitLockWait(client)
  const locked = await client.query<{ id: string }>(
    "SELECT id::text FROM public.lots WHERE public_id = $1 FOR UPDATE", [publicId])
  if (!locked.rows[0]) return null
  const clock = await client.query<{ at: Date }>("SELECT clock_timestamp() AS at")
  return { lotId: locked.rows[0].id, at: clock.rows[0]!.at }
}
