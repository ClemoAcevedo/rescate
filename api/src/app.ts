import express from "express"
import { sendError } from "./http/errors.js"
import type { Router } from "express"

export interface AppDependencies {
  /** Rutas de lotes (K010). Ausente, la API solo expone /health. */
  lotsRouter?: Router
}

export function createApp(dependencies: AppDependencies = {}): express.Express {
  const app = express()

  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next() })

  // Carga útil máxima de 16 KB por cuerpo JSON (anexos H p. 20).
  app.use(express.json({ limit: "16kb", strict: false }))

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" })
  })

  if (dependencies.lotsRouter !== undefined) {
    app.use(dependencies.lotsRouter)
  }

  // Un JSON mal formado o mayor al límite es un error de transporte, no del
  // negocio: se responde sin exponer detalles internos.
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(error)
      return
    }
    const status = typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : 400
    if (status === 413) sendError(res, 413, "PAYLOAD_TOO_LARGE", "El cuerpo supera 16 KiB.")
    else if (status === 415) sendError(res, 415, "UNSUPPORTED_MEDIA_TYPE", "Se requiere application/json.")
    else sendError(res, 400, "MALFORMED_REQUEST", "No se pudo interpretar la solicitud.")
  })

  return app
}
