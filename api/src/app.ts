import express from "express"
import type { Router } from "express"

export interface AppDependencies {
  /** Rutas de lotes (K010). Ausente, la API solo expone /health. */
  lotsRouter?: Router
}

export function createApp(dependencies: AppDependencies = {}): express.Express {
  const app = express()

  // Carga útil máxima de 16 KB por cuerpo JSON (anexos H p. 20).
  app.use(express.json({ limit: "16kb" }))

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" })
  })

  if (dependencies.lotsRouter !== undefined) {
    app.use("/lots", dependencies.lotsRouter)
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
    res.status(Number.isInteger(status) && status >= 400 && status < 500 ? status : 400).json({
      error: { code: "invalid_request", message: "La solicitud no tiene el formato esperado." },
    })
  })

  return app
}
