/* eslint-disable react-refresh/only-export-components -- el contexto y su hook comparten la misma frontera. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ConnectionError,
  IdentityRequestError,
  UnexpectedResponseError,
  type LoginResponse,
  type RegisterResponse,
  type Session,
} from '../services/identity-service'
import { identityService } from '../services/identity'

export type SessionStatus = 'checking' | 'authenticated' | 'anonymous' | 'error' | 'signing-out'

type AuthContextValue = {
  status: SessionStatus
  session: Session | null
  csrfToken: string | null
  error: string | null
  refreshSession: () => Promise<void>
  register: (input: { email: string; password: string }) => Promise<RegisterResponse>
  login: (input: { email: string; password: string }) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function messageFor(error: unknown, operation: 'session' | 'register' | 'login' | 'logout'): string {
  if (error instanceof ConnectionError || error instanceof TypeError) {
    return 'No fue posible conectar con el servicio. Revisa tu conexión e inténtalo nuevamente.'
  }
  if (error instanceof UnexpectedResponseError) return 'El servicio respondió de una forma inesperada. Inténtalo nuevamente más tarde.'
  if (error instanceof IdentityRequestError) {
    if (error.error.code === 'UNAUTHENTICATED' && operation === 'login') return 'El correo o la contraseña no son válidos.'
    if (error.error.code === 'FORBIDDEN') return 'La solicitud fue rechazada por seguridad o permisos. Recarga la página e inténtalo nuevamente.'
    if (error.error.code === 'RATE_LIMITED') return 'Hay demasiados intentos. Espera un momento antes de reintentar.'
    if (error.error.code === 'CONFLICT' && operation === 'register') return 'Ya existe una cuenta con ese correo.'
    if (error.error.code === 'VALIDATION_ERROR') return 'Revisa los campos indicados.'
    if (error.error.code === 'SERVICE_UNAVAILABLE') return 'El servicio no está disponible temporalmente. Inténtalo nuevamente más tarde.'
  }
  return operation === 'logout'
    ? 'No se pudo cerrar la sesión en el servidor. Tu sesión podría seguir activa; vuelve a intentarlo.'
    : 'No fue posible completar la solicitud. Inténtalo nuevamente más tarde.'
}

export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof IdentityRequestError)) return {}
  return Object.fromEntries(error.error.issues.map((issue) => [issue.path.replace(/^\//, ''), issue.message]))
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('checking')
  const [session, setSession] = useState<Session | null>(null)
  const [csrfToken, setCsrfToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)

  const refreshSession = useCallback(async () => {
    const requestGeneration = ++generation.current
    controller.current?.abort()
    const signalController = new AbortController()
    controller.current = signalController
    setStatus('checking'); setError(null)
    try {
      const response = await identityService.getSession(signalController.signal)
      if (requestGeneration !== generation.current) return
      setSession(response.session); setCsrfToken(response.csrfToken)
      setStatus(response.session ? 'authenticated' : 'anonymous')
    } catch (requestError) {
      if (signalController.signal.aborted || requestGeneration !== generation.current) return
      setError(messageFor(requestError, 'session')); setStatus('error')
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(refreshSession)
    return () => controller.current?.abort()
  }, [refreshSession])

  const requireCsrf = () => {
    if (!csrfToken) throw new Error('Aún se está preparando la protección de la sesión.')
    return csrfToken
  }

  const register = async (input: { email: string; password: string }) => identityService.register(input, requireCsrf())

  const login = async (input: { email: string; password: string }) => {
    const result: LoginResponse = await identityService.login(input, requireCsrf())
    ++generation.current
    controller.current?.abort()
    setSession(result.session); setCsrfToken(result.csrfToken); setError(null); setStatus('authenticated')
  }

  const logout = async () => {
    const requestGeneration = ++generation.current
    controller.current?.abort()
    setStatus('signing-out'); setError(null)
    try {
      await identityService.logout(requireCsrf())
      if (requestGeneration !== generation.current) return
      setSession(null); setCsrfToken(null); setStatus('anonymous')
      await refreshSession()
    } catch (requestError) {
      if (requestGeneration !== generation.current) return
      setError(messageFor(requestError, 'logout')); setStatus(session ? 'authenticated' : 'anonymous')
      // El aviso global presenta el fallo; el botón permite volver a cerrar sesión.
    }
  }

  return <AuthContext.Provider value={{ status, session, csrfToken, error, refreshSession, register, login, logout }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth debe utilizarse dentro de AuthProvider.')
  return context
}

export function authErrorMessage(error: unknown, operation: 'register' | 'login') {
  return messageFor(error, operation)
}
