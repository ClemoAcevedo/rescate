// K010 · Composition: lee configuración, crea el Pool, arma adaptadores y casos
// de uso y entrega las entradas HTTP. No contiene reglas de negocio ni se
// importa desde Domain/Application.

import type { Express } from "express"
import { createLotUseCases } from "./application/lots/use-cases.js"
import { createLotRepository } from "./infrastructure/postgres/lot-repository.js"
import { createPool } from "./infrastructure/postgres/pool.js"
import type { Pool } from "./infrastructure/postgres/pool.js"
import { createApp } from "./app.js"
import { createLotsRouter } from "./http/lots-router.js"
import { selectAuthentication } from "./http/actor.js"

export interface Api {
  app: Express
  /** Cierra el Pool al detener el proceso. */
  close(): Promise<void>
}

export function readDatabaseUrl(environment: NodeJS.ProcessEnv): string {
  const databaseUrl = environment.DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new Error("Falta DATABASE_URL. Revisa api/.env.example y docs/desarrollo-local.md")
  }
  return databaseUrl
}

export function createApi(environment: NodeJS.ProcessEnv = process.env): Api {
  const pool: Pool = createPool({ connectionString: readDatabaseUrl(environment) })
  const useCases = createLotUseCases(createLotRepository(pool), () => new Date())
  const lotsRouter = createLotsRouter({
    useCases,
    authenticate: selectAuthentication(environment),
  })

  return {
    app: createApp({ lotsRouter }),
    close: () => pool.end(),
  }
}
