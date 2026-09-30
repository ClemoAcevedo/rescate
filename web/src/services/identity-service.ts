import {
  ConnectionError,
  HttpError,
  UnexpectedResponseError,
  request,
  type ResponseParser,
} from './http-client'

export type User = { id: string; email: string }
export type OperableEstablishment = { id: string; name: string }
export type Session = {
  user: User
  operableEstablishments: OperableEstablishment[]
  expiresAt: string
}
export type SessionResponse = { session: Session | null; csrfToken: string }
export type RegisterResponse = { user: User }
export type LoginResponse = { session: Session; csrfToken: string }
export type IdentityErrorCode =
  | 'MALFORMED_REQUEST' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'CONFLICT' | 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE' | 'VALIDATION_ERROR'
  | 'RATE_LIMITED' | 'INTERNAL_ERROR' | 'SERVICE_UNAVAILABLE'

export type IdentityError = {
  code: IdentityErrorCode
  message: string
  issues: Array<{ path: string; message: string }>
}

export class IdentityRequestError extends Error {
  readonly kind = 'identity-request'
  readonly error: IdentityError
  readonly status: number

  constructor(error: IdentityError, status: number) {
    super(error.message)
    this.name = 'IdentityRequestError'
    this.error = error
    this.status = status
  }
}

const errorCodes = new Set<IdentityErrorCode>([
  'MALFORMED_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT',
  'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'VALIDATION_ERROR', 'RATE_LIMITED',
  'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseUser(value: unknown): User {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.email !== 'string') {
    throw new Error('La respuesta no contiene un usuario válido.')
  }
  return { id: value.id, email: value.email }
}

function parseSession(value: unknown): Session {
  if (!isRecord(value) || !Array.isArray(value.operableEstablishments) || typeof value.expiresAt !== 'string') {
    throw new Error('La respuesta no contiene una sesión válida.')
  }
  return {
    user: parseUser(value.user),
    operableEstablishments: value.operableEstablishments.map((item) => {
      if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') {
        throw new Error('La respuesta contiene un establecimiento inválido.')
      }
      return { id: item.id, name: item.name }
    }),
    expiresAt: value.expiresAt,
  }
}

const parseSessionResponse: ResponseParser<SessionResponse> = (value) => {
  if (!isRecord(value) || typeof value.csrfToken !== 'string' || !('session' in value)) {
    throw new Error('La respuesta de sesión no tiene el formato esperado.')
  }
  return { csrfToken: value.csrfToken, session: value.session === null ? null : parseSession(value.session) }
}

const parseRegisterResponse: ResponseParser<RegisterResponse> = (value) => {
  if (!isRecord(value)) throw new Error('La respuesta de registro no tiene el formato esperado.')
  return { user: parseUser(value.user) }
}

const parseLoginResponse: ResponseParser<LoginResponse> = (value) => {
  const result = parseSessionResponse(value)
  if (result.session === null) throw new Error('El acceso no devolvió una sesión válida.')
  return { session: result.session, csrfToken: result.csrfToken }
}

function parseError(value: unknown): IdentityError | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== 'string'
    || !errorCodes.has(value.error.code as IdentityErrorCode) || typeof value.error.message !== 'string') return undefined
  const issues = isRecord(value.error.details) && Array.isArray(value.error.details.issues)
    ? value.error.details.issues.flatMap((issue) => isRecord(issue) && typeof issue.path === 'string' && typeof issue.message === 'string'
      ? [{ path: issue.path, message: issue.message }] : [])
    : []
  return { code: value.error.code as IdentityErrorCode, message: value.error.message, issues }
}

async function command<T>(path: string, body: unknown, csrfToken: string, parse: ResponseParser<T>): Promise<T> {
  try {
    return await request({ path, method: 'POST', body, headers: { 'X-CSRF-Token': csrfToken }, parse }) as T
  } catch (error) {
    if (error instanceof HttpError) {
      const identityError = parseError(error.body)
      if (identityError) throw new IdentityRequestError(identityError, error.status)
    }
    throw error
  }
}

export interface IdentityService {
  getSession(signal?: AbortSignal): Promise<SessionResponse>
  register(input: { email: string; password: string }, csrfToken: string): Promise<RegisterResponse>
  login(input: { email: string; password: string }, csrfToken: string): Promise<LoginResponse>
  logout(csrfToken: string): Promise<void>
}

export function createIdentityService(): IdentityService {
  return {
    getSession: async (signal) => {
      try {
        return await request({ path: '/auth/session', parse: parseSessionResponse, signal }) as SessionResponse
      } catch (error) {
        if (error instanceof ConnectionError || error instanceof UnexpectedResponseError) throw error
        if (error instanceof HttpError) {
          const identityError = parseError(error.body)
          if (identityError) throw new IdentityRequestError(identityError, error.status)
        }
        throw error
      }
    },
    register: (input, csrfToken) => command('/auth/register', input, csrfToken, parseRegisterResponse),
    login: (input, csrfToken) => command('/auth/login', input, csrfToken, parseLoginResponse),
    logout: async (csrfToken) => {
      await command('/auth/logout', undefined, csrfToken, (value) => value)
    },
  }
}

export { ConnectionError, UnexpectedResponseError }
