import { LOGIN_WINDOW_MS, SESSION_DURATION_MS, validEmail, validPassword } from "../../domain/identity.js"
import { IdentityError } from "./errors.js"
import type { EmailCanonicalizer, IdentityRepository, IdentityUser, LoginSecurityRepository, PasswordCredential, PasswordHasher, SessionCredentials, SessionRepository, StoredSession } from "./ports.js"

export interface SessionContext { session: StoredSession; user: IdentityUser }
export interface IdentityDependencies {
  identities: IdentityRepository
  canonicalizer: EmailCanonicalizer
  passwords: PasswordHasher
  tokens: SessionCredentials
  sessions: SessionRepository
  security: LoginSecurityRepository
  dummyCredential: PasswordCredential
  now: () => Date
}
export function createIdentityUseCases(d: IdentityDependencies) {
  async function input(email: string, password: string) {
    if (email.includes("\u0000")) throw new IdentityError("invalid_input", ["email"])
    const canonical = await d.canonicalizer.canonicalize(email)
    const fields = [...(validEmail(canonical) ? [] : ["email"]), ...(validPassword(password) ? [] : ["password"])]
    if (fields.length) throw new IdentityError("invalid_input", fields)
    return canonical
  }
  function blocked(until: Date | null | undefined, now: Date) {
    if (until && until > now) throw new IdentityError("login_blocked", [], Math.ceil((until.getTime() - now.getTime()) / 1000))
  }
  return {
    async register(email: string, password: string) {
      if (email.includes("\u0000")) throw new IdentityError("invalid_input", ["email"])
    const canonical = await input(email, password)
      const credential = await d.passwords.hash(password)
      const result = await d.identities.createUserWithCredential(canonical, credential)
      if (result.kind === "email_exists") throw new IdentityError("email_exists")
      return result.user
    },
    async login(email: string, password: string, previousSecret?: string) {
      if (email.includes("\u0000")) throw new IdentityError("invalid_input", ["email"])
    const canonical = await input(email, password)
      const account = await d.identities.findByEmail(canonical)
      if (account) blocked((await d.security.read(account.user.id))?.blockedUntil, d.now())
      // Coste fuera de la transacción. Cuenta inexistente también realiza scrypt.
      const verified = await d.passwords.verify(password, account?.credential ?? d.dummyCredential)
      if (!account) throw new IdentityError("invalid_credentials")
      const issued = d.tokens.issue()
      const previousHash = previousSecret ? d.tokens.fingerprint(previousSecret) : null
      const result = await d.security.withAccountLock(account.user.id, async (state, writer) => {
        const now = d.now() // Releer después de esperar el lock, no antes de scrypt.
        blocked(state.blockedUntil, now)
        const cutoff = new Date(now.getTime() - LOGIN_WINDOW_MS)
        await writer.deleteFailuresThrough(cutoff)
        await writer.setBlockedUntil(null)
        if (!verified || !account.credential) {
          const recent = state.failureTimes.filter(at => at > cutoff && at <= now).length
          await writer.recordFailure(now)
          if (recent + 1 >= 5) await writer.setBlockedUntil(new Date(now.getTime() + LOGIN_WINDOW_MS))
          return null // Confirmar el fallo antes de responder 401.
        }
        // Éxito no borra fallos recientes. Rotación y nueva sesión son atómicas.
        if (previousHash) await writer.revokePresentedSession(previousHash, now)
        return writer.createSession({ tokenHash: issued.tokenHash, createdAt: now,
          expiresAt: new Date(now.getTime() + SESSION_DURATION_MS) })
      })
      if (!result) throw new IdentityError("invalid_credentials")
      return { secret: issued.secret, context: { session: result, user: account.user } }
    },
    async resolveSession(secret?: string): Promise<SessionContext | null> {
      const hash = secret ? d.tokens.fingerprint(secret) : null
      if (!hash) return null
      const session = await d.sessions.findByTokenHash(hash)
      if (!session || session.revokedAt || session.expiresAt <= d.now()) return null
      const user = await d.identities.findUserById(session.userId)
      return user ? { session, user } : null
    },
    async describeSession(context: SessionContext) {
      return { user: { id: context.user.publicId, email: context.user.email },
        operableEstablishments: await d.identities.listEstablishments(context.user.id),
        expiresAt: context.session.expiresAt.toISOString() }
    },
    async logout(context: SessionContext) {
      const now = d.now()
      if (context.session.expiresAt <= now || !await d.sessions.revoke(context.session.id, now)) throw new IdentityError("no_session")
    },
  }
}
export type IdentityUseCases = ReturnType<typeof createIdentityUseCases>
