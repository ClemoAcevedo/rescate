// Composition: configuración y ensamblado; las políticas viven en Application/HTTP.
import type { Express } from "express"
import { createLotUseCases } from "./application/lots/use-cases.js"
import { createDiscoveryUseCases } from "./application/discovery/use-cases.js"
import { createIdentityUseCases } from "./application/identity/use-cases.js"
import { createLotRepository } from "./infrastructure/postgres/lot-repository.js"
import { createDiscoveryRepository } from "./infrastructure/postgres/discovery-repository.js"
import { createEmailCanonicalizer, createIdentityRepository } from "./infrastructure/postgres/identity-repository.js"
import { createSessionRepository } from "./infrastructure/postgres/session-repository.js"
import { createLoginSecurityRepository } from "./infrastructure/postgres/login-security-repository.js"
import { createPasswordHasher, createDummyCredential } from "./infrastructure/crypto/passwords.js"
import { createSessionCredentials } from "./infrastructure/crypto/session-credentials.js"
import { createCsrfTokens } from "./infrastructure/crypto/csrf.js"
import { createPool } from "./infrastructure/postgres/pool.js"
import { createPhotoUseCases } from "./application/photos/use-cases.js"
import type { ObjectStore } from "./application/photos/ports.js"
import { createPhotoRepository } from "./infrastructure/postgres/photo-repository.js"
import { createLocalObjectStore } from "./infrastructure/objects/local-object-store.js"
import { createS3ObjectStore } from "./infrastructure/objects/s3-object-store.js"
import { createSharpImageProcessor } from "./infrastructure/images/sharp-image-processor.js"
import { createApp } from "./app.js"
import { createPhotosRouter } from "./http/photos-router.js"
import { createLotsRouter } from "./http/lots-router.js"
import { createDiscoveryRouter } from "./http/discovery-router.js"
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
/**
 * PHOTO_STORAGE elige el almacenamiento de fotos: `s3` (bucket privado B2) o
 * `local` (directorio de desarrollo). Sin valor, cargar fotos responde 503.
 */
export function readPhotoStorage(environment: NodeJS.ProcessEnv): ObjectStore | null {
  const kind = environment.PHOTO_STORAGE?.trim() ?? ""
  if (kind === "") return null
  if (kind === "local") {
    // Anexos I p. 24: las fotos no van en el disco efímero de la API.
    if (environment.NODE_ENV === "production") throw new Error("PHOTO_STORAGE=local no es válido en producción")
    const directory = environment.PHOTO_LOCAL_DIR?.trim()
    if (!directory) throw new Error("PHOTO_STORAGE=local requiere PHOTO_LOCAL_DIR")
    return createLocalObjectStore(directory)
  }
  if (kind !== "s3") throw new Error("PHOTO_STORAGE admite s3 o local")
  const required = (name: string) => {
    const value = environment[name]?.trim()
    if (!value) throw new Error(`PHOTO_STORAGE=s3 requiere ${name}`)
    return value
  }
  const endpoint = new URL(required("PHOTO_S3_ENDPOINT"))
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("PHOTO_S3_ENDPOINT requiere HTTPS sin credenciales ni parámetros")
  }
  return createS3ObjectStore({
    endpoint: endpoint.href, region: required("PHOTO_S3_REGION"), bucket: required("PHOTO_S3_BUCKET"),
    accessKeyId: required("PHOTO_S3_ACCESS_KEY_ID"), secretAccessKey: required("PHOTO_S3_SECRET_ACCESS_KEY"),
  })
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
  // La API autoriza, recibe y sirve; decodificar y transformar corresponde al worker.
  const photos = createPhotoUseCases({ repository: createPhotoRepository(pool), objects: readPhotoStorage(environment),
    images: null, now: () => new Date(), log: event => console.error(event) })
  const photosRouter = createPhotosRouter({ useCases: photos, authenticate: authentication.authenticate,
    protectCommand: authentication.protectCommand })
  const discoveryRouter = createDiscoveryRouter(createDiscoveryUseCases(createDiscoveryRepository(pool), () => new Date()),
    authentication.authenticate, authentication.protectCommand)
  return { app: createApp({ lotsRouter, discoveryRouter, photosRouter, authRouter: createAuthRouter(identities, authentication, limits),
    traffic: (req, res, next) => {
      if (req.path === "/health") { next(); return }
      try { limits.ip(req.ip ?? req.socket.remoteAddress ?? "unknown"); next() }
      catch (error) { handleError(error, res, console.error) }
    },
  }), close: () => pool.end() }
}

export interface PhotoWorker { run(): Promise<void>; stop(): void }

/**
 * Worker de fotos: valida una foto por vez y limpia objetos cada minuto. Reutiliza
 * los casos de uso de Application; sin base o almacenamiento queda inactivo.
 */
export function createPhotoWorker(environment: NodeJS.ProcessEnv = process.env,
  log: (event: Record<string, unknown>) => void = event => console.log(JSON.stringify(event))): PhotoWorker | null {
  const objects = readPhotoStorage(environment)
  const databaseUrl = environment.DATABASE_URL?.trim()
  if (objects === null || !databaseUrl) return null
  // Anexos H p. 20: dos conexiones para el trabajador.
  const pool = createPool({ connectionString: databaseUrl, max: 2 })
  const photos = createPhotoUseCases({ repository: createPhotoRepository(pool), objects,
    images: createSharpImageProcessor(), now: () => new Date(), log })
  let running = true
  let wake: (() => void) | null = null
  const pause = (ms: number) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    wake = () => { clearTimeout(timer); resolve() }
  })
  return {
    async run() {
      let nextCleanup = 0
      while (running) {
        try {
          if (Date.now() >= nextCleanup) {
            await photos.cleanup()
            nextCleanup = Date.now() + 60_000
          }
          if (!(await photos.processNext())) await pause(2000)
        } catch (error) {
          // Sin SQL, rutas ni credenciales en el registro; se reintenta más tarde.
          const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""
          log({ event: "photo_worker_error", code: /^[A-Z0-9_]{2,30}$/.test(code) ? code : "INTERNAL" })
          await pause(5000)
        }
      }
      await pool.end()
    },
    stop() {
      running = false
      wake?.()
    },
  }
}
