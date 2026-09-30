import type { IdentityService, LoginResponse, RegisterResponse, SessionResponse } from './identity-service'
import { IdentityRequestError } from './identity-service'

type MockScenario = 'success' | 'validation' | 'credentials' | 'network' | 'forbidden' | 'logout-failure'

const scenario = import.meta.env.DEV ? (import.meta.env.VITE_AUTH_MOCK_SCENARIO as MockScenario | undefined) : undefined
const delay = Number(import.meta.env.VITE_AUTH_MOCK_DELAY_MS ?? 450)
const user = { id: 'usr_controlled_A7k', email: 'persona@example.com' }
let authenticated = false

function wait() { return new Promise<void>((resolve) => window.setTimeout(resolve, Number.isFinite(delay) ? delay : 450)) }
function controlledError(code: 'VALIDATION_ERROR' | 'UNAUTHENTICATED' | 'FORBIDDEN', status: number, message: string) {
  return new IdentityRequestError({ code, message, issues: code === 'VALIDATION_ERROR' ? [{ path: '/email', message: 'El correo de prueba no es válido.' }] : [] }, status)
}

/** Simulación explícita, solo para desarrollo. Nunca se activa por un fallo de la API real. */
export function createMockIdentityService(): IdentityService | undefined {
  if (!scenario) return undefined
  return {
    getSession: async (): Promise<SessionResponse> => {
      await wait()
      if (scenario === 'network') throw new TypeError('Fallo de red controlado.')
      return { session: authenticated ? { user, operableEstablishments: [], expiresAt: '2030-01-15T22:00:00Z' } : null, csrfToken: 'csrf-controlado' }
    },
    register: async (): Promise<RegisterResponse> => {
      await wait()
      if (scenario === 'validation') throw controlledError('VALIDATION_ERROR', 422, 'Revisa los campos indicados.')
      if (scenario === 'forbidden') throw controlledError('FORBIDDEN', 403, 'La protección de la solicitud fue rechazada.')
      if (scenario === 'network') throw new TypeError('Fallo de red controlado.')
      return { user }
    },
    login: async (): Promise<LoginResponse> => {
      await wait()
      if (scenario === 'credentials') throw controlledError('UNAUTHENTICATED', 401, 'Las credenciales no son válidas.')
      if (scenario === 'forbidden') throw controlledError('FORBIDDEN', 403, 'La protección de la solicitud fue rechazada.')
      if (scenario === 'network') throw new TypeError('Fallo de red controlado.')
      authenticated = true
      return { session: { user, operableEstablishments: [], expiresAt: '2030-01-15T22:00:00Z' }, csrfToken: 'csrf-controlado-auth' }
    },
    logout: async () => {
      await wait()
      if (scenario === 'logout-failure' || scenario === 'network') throw new TypeError('Fallo de red controlado.')
      if (scenario === 'forbidden') throw controlledError('FORBIDDEN', 403, 'La protección de la solicitud fue rechazada.')
      authenticated = false
    },
  }
}
