// Composition: configuración y ensamblado; las políticas viven en Application/HTTP.
import type { Express } from "express"
import { createLotUseCases } from "./application/lots/use-cases.js"
import { createIdentityUseCases } from "./application/identity/use-cases.js"
import { createLotRepository } from "./infrastructure/postgres/lot-repository.js"
import { createEmailCanonicalizer, createIdentityRepository } from "./infrastructure/postgres/identity-repository.js"
import { createSessionRepository } from "./infrastructure/postgres/session-repository.js"
import { createLoginSecurityRepository } from "./infrastructure/postgres/login-security-repository.js"
import { createPasswordHasher, createDummyCredential } from "./infrastructure/crypto/passwords.js"
import { createSessionCredentials } from "./infrastructure/crypto/session-credentials.js"
import { createCsrfTokens } from "./infrastructure/crypto/csrf.js"
import { createPool } from "./infrastructure/postgres/pool.js"
import { createApp } from "./app.js"
import { createLotsRouter } from "./http/lots-router.js"
import { createAuthRouter } from "./http/auth-router.js"
import { createAuthentication } from "./http/authentication.js"
import { createTrafficLimits } from "./http/rate-limits.js"
import { handleError } from "./http/errors.js"

export interface Api { app: Express; close(): Promise<void> }
export function readDatabaseUrl(environment: NodeJS.ProcessEnv): string {
  const databaseUrl = environment.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error("Falta DATABASE_URL. Revisa api/.env.example y docs/desarrollo-local.md")
  return databaseUrl
}
export function readAuthConfiguration(environment: NodeJS.ProcessEnv) {
  const values = environment.RESCATE_ALLOWED_ORIGINS?.split(",").map(s => s.trim()).filter(Boolean) ?? []
  if (!values.length || values.some(value => {
    try { const url = new URL(value); return url.protocol !== "https:" || url.origin !== value } catch { return true }
  })) throw new Error("RESCATE_ALLOWED_ORIGINS requiere orígenes HTTPS exactos separados por coma")
  const encoded = environment.CSRF_SIGNING_KEY ?? ""
  if (environment.NODE_ENV === "production" && encoded === "cmVzY2F0ZS1kZXYtb25seS1ub3QtYS1yZWFsLXNlY3JldA==") {
    throw new Error("La clave ficticia de Compose no es válida en producción")
  }
  const key = Buffer.from(encoded, "base64")
  if (key.length < 32 || key.toString("base64") !== encoded) throw new Error("CSRF_SIGNING_KEY requiere al menos 32 bytes aleatorios en base64 canónico")
  return { origins: new Set(values), key }
}
export function createApi(environment: NodeJS.ProcessEnv = process.env): Api {
  const config = readAuthConfiguration(environment)
  const pool = createPool({ connectionString: readDatabaseUrl(environment) })
  const identities = createIdentityUseCases({ identities: createIdentityRepository(pool),
    canonicalizer: createEmailCanonicalizer(pool), passwords: createPasswordHasher(), tokens: createSessionCredentials(),
    sessions: createSessionRepository(pool), security: createLoginSecurityRepository(pool),
    dummyCredential: createDummyCredential(), now: () => new Date() })
  const limits = createTrafficLimits()
  const authentication = createAuthentication(identities, createCsrfTokens(config.key), config.origins, limits)
  const lotsRouter = createLotsRouter({ useCases: createLotUseCases(createLotRepository(pool), () => new Date()),
    authenticate: authentication.authenticate, protectCommand: authentication.protectCommand })
  return { app: createApp({ lotsRouter, authRouter: createAuthRouter(identities, authentication, limits),
    traffic: (req, res, next) => {
      if (req.path === "/health") { next(); return }
      try { limits.ip(req.ip ?? req.socket.remoteAddress ?? "unknown"); next() }
      catch (error) { handleError(error, res, console.error) }
    },
  }), close: () => pool.end() }
}
