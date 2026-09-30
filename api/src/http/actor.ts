import type { Request } from "express"
import type { Actor } from "../application/lots/ports.js"

/** Identidad obtenida únicamente de una sesión real por Composition. */
export type Authenticate = (request: Request) => Promise<Actor | null>
