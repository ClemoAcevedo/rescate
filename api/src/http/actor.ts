// K010 · HTTP: obtención del actor autenticado.
//
// K008 implementa sesión opaca, cookie y CSRF (anexos H p. 21). Hasta que esa
// tarjeta se integre, K010 deja el punto de conexión definido y, de forma
// predeterminada, responde 401: no existe una sesión real que autenticar.
//
// Para poder ejercitar los endpoints en desarrollo hay un actor explícito por
// cabecera, deshabilitado salvo que RESCATE_DEV_ACTOR valga "enabled". No es un
// mecanismo de autenticación: no verifica credenciales y nunca debe habilitarse
// fuera de una base de desarrollo con datos ficticios.

import type { Request } from "express"
import type { Actor } from "../application/lots/ports.js"

export type Authenticate = (request: Request) => Promise<Actor | null>

export const DEV_ACTOR_HEADER = "x-rescate-dev-actor"

/** Sin K008 integrado no hay sesión: toda operación autenticada responde 401. */
export const noAuthentication: Authenticate = async () => null

export function createDevActorAuthentication(): Authenticate {
  return async (request) => {
    const header = request.header(DEV_ACTOR_HEADER)
    if (header === undefined) return null
    const userId = header.trim()
    // Clave interna bigint transportada como texto, sin convertir a Number.
    return /^[1-9][0-9]{0,18}$/.test(userId) && BigInt(userId) <= 9223372036854775807n ? { userId } : null
  }
}

/**
 * Elige el mecanismo según configuración. El valor predeterminado es no
 * autenticar; habilitar el actor de desarrollo exige una decisión explícita.
 */
export function selectAuthentication(environment: NodeJS.ProcessEnv): Authenticate {
  const enabled = environment.RESCATE_DEV_ACTOR === "enabled"
  if (!enabled) return noAuthentication
  if (environment.NODE_ENV === "production") {
    throw new Error("RESCATE_DEV_ACTOR no puede habilitarse con NODE_ENV=production")
  }
  console.warn(
    "ATENCIÓN: actor de desarrollo habilitado por cabecera. Sin autenticación real hasta K008.",
  )
  return createDevActorAuthentication()
}
