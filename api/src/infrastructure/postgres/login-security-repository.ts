import type { LoginSecurityRepository, LoginSecurityState, LoginSecurityWriter } from "../../application/identity/ports.js"
import { withTransaction } from "./pool.js"
import type { Pool, PoolClient } from "./pool.js"
import { insertSession } from "./session-repository.js"

async function readState(db: Pick<PoolClient, "query">, userId: string): Promise<LoginSecurityState | null> {
  // Un solo snapshot para estado y eventos, también en la lectura preliminar.
  const { rows } = await db.query<{ blocked_until: Date | null; failure_times: Date[] }>(`
    SELECT s.blocked_until, ARRAY(SELECT f.failed_at FROM public.login_failures f
      WHERE f.user_id=s.user_id ORDER BY f.failed_at,f.id) AS failure_times
    FROM public.login_security_state s WHERE s.user_id=$1`, [userId])
  return rows[0] ? { blockedUntil: rows[0].blocked_until, failureTimes: rows[0].failure_times } : null
}

export function createLoginSecurityRepository(pool: Pool): LoginSecurityRepository {
  return {
    read: userId => readState(pool, userId),
    withAccountLock: (userId, operate) => withTransaction(pool, async client => {
      // Límite de espera de E1 H p. 20. Solo dura esta transacción.
      await client.query("SET LOCAL lock_timeout = '2s'")
      // ON CONFLICT también espera una inicialización concurrente no confirmada.
      await client.query("INSERT INTO public.login_security_state(user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [userId])
      await client.query("SELECT user_id FROM public.login_security_state WHERE user_id=$1 FOR UPDATE", [userId])
      const state = await readState(client, userId)
      if (!state) throw new Error("No se pudo releer el estado de login bloqueado")
      return operate(state, createWriter(client, userId))
    }),
  }
}

function createWriter(client: PoolClient, userId: string): LoginSecurityWriter {
  return {
    async deleteFailuresThrough(cutoff) {
      await client.query("DELETE FROM public.login_failures WHERE user_id=$1 AND failed_at <= $2", [userId, cutoff])
    },
    async recordFailure(at) {
      await client.query("INSERT INTO public.login_failures(user_id,failed_at) VALUES ($1,$2)", [userId, at])
    },
    async setBlockedUntil(until) {
      await client.query("UPDATE public.login_security_state SET blocked_until=$2 WHERE user_id=$1", [userId, until])
    },
    createSession: input => insertSession(client, { ...input, userId }),
    async revokePresentedSession(tokenHash, at) {
      await client.query("UPDATE public.sessions SET revoked_at=$2 WHERE token_hash=$1 AND revoked_at IS NULL", [Buffer.from(tokenHash), at])
    },
    async revokeSession(sessionId, at) {
      const result = await client.query(`UPDATE public.sessions SET revoked_at=$3
        WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, [sessionId, userId, at])
      return result.rowCount === 1
    },
  }
}
