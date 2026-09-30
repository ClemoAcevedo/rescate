// K008: contratos de datos y atomicidad de Application.
// No pasan Request, cookies, Buffer, Pool ni clientes PostgreSQL.
export interface IdentityUser {
  id: string // PK bigint interna, sin convertir a Number.
  publicId: string
  email: string
}

export interface ScryptParameters {
  N: number
  r: number
  p: number
}

export interface PasswordCredential {
  hash: Uint8Array
  salt: Uint8Array
  parameters: ScryptParameters
}

export interface EmailCanonicalizer {
  /** Fuente única: canonicalize_email de PostgreSQL. No valida formato. */
  canonicalize(input: string): Promise<string>
}

export interface IdentityRepository {
  findByEmail(canonicalEmail: string): Promise<{ user: IdentityUser; credential: PasswordCredential | null } | null>
  listEstablishments(userId: string): Promise<Array<{ id: string; name: string }>>
  findUserById(userId: string): Promise<IdentityUser | null>
  /** Confirma ambas filas o ninguna. No normaliza, hashea, autentica ni da permisos. */
  createUserWithCredential(canonicalEmail: string, credential: PasswordCredential): Promise<
    { kind: "created"; user: IdentityUser } | { kind: "email_exists" }
  >
}

export interface PasswordHasher {
  hash(password: string): Promise<PasswordCredential>
  /** Usa los parámetros de la credencial, no los de nuevas contraseñas. */
  verify(password: string, credential: PasswordCredential): Promise<boolean>
}

export interface SessionCredentials {
  issue(): { secret: string; tokenHash: Uint8Array }
  /** null si el secreto no tiene la codificación canónica esperada. */
  fingerprint(secret: string): Uint8Array | null
}

export interface NewSession {
  userId: string
  tokenHash: Uint8Array // La persistencia nunca recibe el secreto reutilizable.
  createdAt: Date
  expiresAt: Date
}

export interface StoredSession {
  id: string
  userId: string
  createdAt: Date
  expiresAt: Date
  revokedAt: Date | null
}

export interface SessionRepository {
  create(input: NewSession): Promise<StoredSession>
  /** Devuelve hechos, incluso si venció/se revocó; Application decide vigencia. */
  findByTokenHash(tokenHash: Uint8Array): Promise<StoredSession | null>
  /** Cambia solo una revocación todavía NULL; no decide si se permite logout. */
  revoke(sessionId: string, revokedAt: Date): Promise<boolean>
}

export interface LoginSecurityState {
  blockedUntil: Date | null
  failureTimes: Date[]
}

export interface LoginSecurityWriter {
  /** Borra inclusive el límite elegido por Application. */
  deleteFailuresThrough(cutoff: Date): Promise<void>
  recordFailure(at: Date): Promise<void>
  setBlockedUntil(until: Date | null): Promise<void>
  createSession(input: Omit<NewSession, "userId">): Promise<StoredSession>
  /** Rotación: prueba de posesión de la sesión anterior, incluso al cambiar de cuenta. */
  revokePresentedSession(tokenHash: Uint8Array, at: Date): Promise<void>
  /** Solo puede revocar una sesión de la cuenta bloqueada. */
  revokeSession(sessionId: string, at: Date): Promise<boolean>
}

export interface LoginSecurityRepository {
  /** Lectura preliminar, no concede permiso para un login posterior. */
  read(userId: string): Promise<LoginSecurityState | null>
  /**
   * Inicializa si hace falta, bloquea y relee antes del callback. Toda escritura
   * usa la misma transacción. El callback decide reglas/instante después de esperar;
   * no debe ejecutar scrypt ni llamadas externas. No se retiene el writer al salir.
   */
  withAccountLock<T>(userId: string, operate: (state: LoginSecurityState, writer: LoginSecurityWriter) => Promise<T>): Promise<T>
}
