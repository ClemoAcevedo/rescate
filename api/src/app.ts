import { randomUUID } from "node:crypto"
import express from "express"
import { handleError, requestIdOf, sendError } from "./http/errors.js"
import type { Router } from "express"
import { errorCode } from "./application/logging.js"
import type { Log } from "./application/logging.js"
import type { Health } from "./application/operations/ports.js"
import type { HttpSchemas } from "./http/openapi.js"

export interface AppDependencies {
  /** Entradas opcionales para pruebas; Composition monta K008 y K010. */
  lotsRouter?: Router
  discoveryRouter?: Router
  reservationsRouter?: Router
  waitlistRouter?: Router
  notificationsRouter?: Router
  chatRouter?: Router
  panelRouter?: Router
  photosRouter?: Router
  authRouter?: Router
  traffic?: express.RequestHandler
  /** Registro sin datos de la solicitud; por defecto, una línea JSON en la salida estándar. */
  log?: Log
  /** Acceso a la base y latido del worker; sin él, la salud solo comprueba el proceso. */
  health?: () => Promise<Health>
}

export function createApp(dependencies: AppDependencies = {}): express.Express {
  const app = express()
  const log = dependencies.log ?? (event => console.log(JSON.stringify(event)))
  // Sin anunciar el framework; nosniff también en JSON y errores, no solo en fotos.
  app.disable("x-powered-by")

  app.use((_req, res, next) => { res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); next() })

  // K036: una línea por solicitud con un identificador generado, la operación como plantilla
  // de la ruta (nunca la URL con valores), el estado y la duración. request_failed lleva el
  // mismo identificador. Se registra también lo que corta el límite por IP. Sin respuesta
  // enviada (conexión cortada antes), el estado es null.
  app.use((req, res, next) => {
    if (req.path === "/health") { next(); return }
    const started = performance.now()
    res.locals.requestId = randomUUID()
    res.once("close", () => log({ event: "request", requestId: requestIdOf(res),
      // Los routers se montan sin prefijo: baseUrl es "". Un prefijo con parámetro traería su valor.
      operation: `${req.method} ${req.route ? `${req.baseUrl}${String(req.route.path)}` : "(sin ruta)"}`,
      status: res.headersSent ? res.statusCode : null, durationMs: Math.round(performance.now() - started),
      completed: res.writableFinished }))
    next()
  })

  if (dependencies.traffic) app.use(dependencies.traffic)

  // Carga útil máxima de 16 KB por cuerpo JSON (anexos H p. 20).
  app.use(express.json({ limit: "16kb", strict: false }))

  app.get("/health", async (_req, res) => {
    if (!dependencies.health) { res.json({ status: "ok" }); return }
    const health = await dependencies.health()
    const body: HttpSchemas["HealthStatus"] = { status: health.database === "ok" ? "ok" : "unavailable", ...health }
    res.status(health.database === "ok" ? 200 : 503).json(body)
  })

  if (dependencies.authRouter) app.use(dependencies.authRouter)
  if (dependencies.discoveryRouter) app.use(dependencies.discoveryRouter)
  if (dependencies.reservationsRouter) app.use(dependencies.reservationsRouter)
  if (dependencies.waitlistRouter) app.use(dependencies.waitlistRouter)
  if (dependencies.notificationsRouter) app.use(dependencies.notificationsRouter)
  if (dependencies.chatRouter) app.use(dependencies.chatRouter)
  if (dependencies.panelRouter) app.use(dependencies.panelRouter)
  // Fotos: cuerpo binario con su propio límite; express.json ignora image/*.
  if (dependencies.photosRouter) app.use(dependencies.photosRouter)

  if (dependencies.lotsRouter !== undefined) {
    app.use(dependencies.lotsRouter)
  }

  // Un JSON mal formado o mayor al límite es un error de transporte, no del
  // negocio: se responde sin exponer detalles internos.
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) {
      // El manejador final de Express imprimiría el stack, que puede traer valores de SQL o
      // de la solicitud: se registra solo el código y se corta la respuesta ya iniciada.
      log({ event: "request_failed", requestId: requestIdOf(res), code: errorCode(error) })
      res.destroy()
      return
    }
    const status = typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : 500
    if (status === 413) sendError(res, 413, "PAYLOAD_TOO_LARGE", "El cuerpo supera 16 KiB.")
    else if (status === 415) sendError(res, 415, "UNSUPPORTED_MEDIA_TYPE", "Se requiere application/json.")
    else if (status === 400) sendError(res, 400, "MALFORMED_REQUEST", "No se pudo interpretar la solicitud.")
    else handleError(error, res, log)
  })

  return app
}
