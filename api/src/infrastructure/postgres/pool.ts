// K010 · Infrastructure: conexión PostgreSQL. Application no recibe el Pool ni
// clientes pg; los ports exponen operaciones, no la librería.

import pg from "pg"

export type Pool = pg.Pool
export type PoolClient = pg.PoolClient

export interface PoolOptions {
  connectionString: string
  /** Anexos H p. 20: 8 conexiones para la API y 2 para el trabajador. */
  max?: number
  connectionTimeoutMillis?: number
  statementTimeoutMillis?: number
}

export function createPool(options: PoolOptions): Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 8,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
    // Límite de consulta de H p. 20; evita retener un cliente indefinidamente.
    statement_timeout: options.statementTimeoutMillis ?? 5000,
  })
}

/**
 * Ejecuta los pasos con un mismo cliente dentro de una transacción y libera el
 * recurso siempre. Solo se informa éxito después del COMMIT.
 */
export async function withTransaction<T>(pool: Pool, steps: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await steps(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    try {
      await client.query("ROLLBACK")
    } catch {
      // Un ROLLBACK fallido no debe ocultar el error original de la operación.
    }
    throw error
  } finally {
    client.release()
  }
}
