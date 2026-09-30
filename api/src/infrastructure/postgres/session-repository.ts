import type { NewSession, SessionRepository, StoredSession } from "../../application/identity/ports.js"
import type { Pool, PoolClient } from "./pool.js"

interface SessionRow {
  id: string
  user_id: string
  created_at: Date
  expires_at: Date
  revoked_at: Date | null
}
const columns = "id::text, user_id::text, created_at, expires_at, revoked_at"
const toSession = (row: SessionRow): StoredSession => ({
  id: row.id, userId: row.user_id, createdAt: row.created_at,
  expiresAt: row.expires_at, revokedAt: row.revoked_at,
})

function hashBytes(hash: Uint8Array): Buffer {
  if (!(hash instanceof Uint8Array) || hash.byteLength !== 32) throw new Error("Huella de sesión inválida")
  return Buffer.from(hash)
}

// Helper interno de Infrastructure: también lo usa el writer de login con SU
// cliente transaccional. No se expone pg ni la credencial secreta en los ports.
export async function insertSession(db: Pick<PoolClient, "query">, input: NewSession): Promise<StoredSession> {
  const { rows } = await db.query<SessionRow>(`INSERT INTO public.sessions
    (user_id,token_hash,created_at,expires_at) VALUES ($1,$2,$3,$4) RETURNING ${columns}`,
  [input.userId, hashBytes(input.tokenHash), input.createdAt, input.expiresAt])
  return toSession(rows[0]!)
}

export function createSessionRepository(pool: Pool): SessionRepository {
  return {
    create: input => insertSession(pool, input),
    async findByTokenHash(tokenHash) {
      const { rows } = await pool.query<SessionRow>(`SELECT ${columns} FROM public.sessions WHERE token_hash=$1`, [hashBytes(tokenHash)])
      return rows[0] ? toSession(rows[0]) : null
    },
    async revoke(sessionId, at) {
      const result = await pool.query("UPDATE public.sessions SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL", [sessionId, at])
      return result.rowCount === 1
    },
  }
}
