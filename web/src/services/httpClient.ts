export type Validator<T> = (value: unknown) => value is T

type BaseRequest = {
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  headers?: HeadersInit
}

type JsonRequest<T> = BaseRequest & {
  response: 'json'
  validate: Validator<T>
}

type EmptyResponseRequest = BaseRequest & {
  response: 'none'
}

export class HttpError extends Error {
  readonly kind = 'http'
  readonly status: number
  readonly body: unknown
  readonly headers: Headers

  constructor(status: number, body: unknown, headers: Headers) {
    super(`La solicitud falló con estado HTTP ${status}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
    this.headers = headers
  }
}

export class NetworkError extends Error {
  readonly kind = 'network'
  readonly cause: unknown

  constructor(cause: unknown) {
    super('No fue posible conectar con la API')
    this.name = 'NetworkError'
    this.cause = cause
  }
}

export class UnexpectedResponseError extends Error {
  readonly kind = 'unexpected-response'
  readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'UnexpectedResponseError'
    this.cause = cause
  }
}

function getApiBaseUrl() {
  return (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
}

function getUrl(path: string) {
  return `${getApiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()

  if (text === '') {
    return undefined
  }

  if (response.headers.get('content-type')?.includes('application/json')) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }

  return text
}

function createRequestInit(request: BaseRequest): RequestInit {
  const headers = new Headers(request.headers)
  let body: string | undefined

  if (request.body !== undefined) {
    body = JSON.stringify(request.body)
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
  }

  return {
    method: request.method ?? 'GET',
    headers,
    body,
  }
}

export async function request<T>(request: JsonRequest<T>): Promise<T>
export async function request(request: EmptyResponseRequest): Promise<void>
export async function request<T>(
  request: JsonRequest<T> | EmptyResponseRequest,
): Promise<T | void> {
  let response: Response

  try {
    response = await fetch(getUrl(request.path), createRequestInit(request))
  } catch (error) {
    throw new NetworkError(error)
  }

  let body: unknown
  try {
    body = await readBody(response)
  } catch (error) {
    throw new UnexpectedResponseError('No fue posible leer la respuesta de la API', error)
  }

  if (!response.ok) {
    throw new HttpError(response.status, body, response.headers)
  }

  if (request.response === 'none') {
    return
  }

  if (body === undefined) {
    throw new UnexpectedResponseError('La API respondió sin contenido JSON')
  }

  if (!request.validate(body)) {
    throw new UnexpectedResponseError('La respuesta de la API no tiene el formato esperado')
  }

  return body
}
