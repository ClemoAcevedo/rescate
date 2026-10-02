export class HttpError extends Error {
  readonly kind = 'http'
  readonly status: number
  readonly statusText: string
  readonly body: unknown
  /** Segundos de `Retry-After`, si la respuesta lo indica (por ejemplo en 429). */
  readonly retryAfter: number | null

  constructor(status: number, statusText: string, body: unknown, retryAfter: number | null = null) {
    super(`HTTP ${status} ${statusText}`)
    this.name = 'HttpError'
    this.status = status
    this.statusText = statusText
    this.body = body
    this.retryAfter = retryAfter
  }
}

export class ConnectionError extends Error {
  readonly kind = 'connection'
  readonly cause: unknown

  constructor(cause: unknown) {
    super('No fue posible conectar con la API.')
    this.name = 'ConnectionError'
    this.cause = cause
  }
}

export class UnexpectedResponseError extends Error {
  readonly kind = 'unexpected-response'
  readonly body: unknown
  readonly url: string
  readonly status: number
  readonly contentType: string | null

  constructor(message: string, body: unknown, response?: Response) {
    super(message)
    this.name = 'UnexpectedResponseError'
    this.body = body
    this.url = response?.url ?? ''
    this.status = response?.status ?? 0
    this.contentType = response?.headers.get('content-type') ?? null
  }
}

export type ResponseParser<T> = (body: unknown) => T

export interface HttpRequest<T> {
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** JSON serializable, o un Blob (archivo) que se envía tal cual con su propio Content-Type. */
  body?: unknown
  headers?: HeadersInit
  /** Valida en tiempo de ejecución un cuerpo exitoso con contenido. */
  parse?: ResponseParser<T>
  signal?: AbortSignal
}

/** URL bajo la base de la API, también para recursos como imágenes de lotes. */
export function buildUrl(path: string): string {
  // El proxy documentado vive bajo /api. Evita que, sin .env local, una ruta de
  // API caiga en el fallback HTML de Vite y se interprete como respuesta JSON.
  const baseUrl = import.meta.env.VITE_API_BASE_URL?.trim() || '/api'

  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()

  if (!text) {
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

export async function request<T = unknown>({
  path,
  method = 'GET',
  body,
  headers,
  parse,
  signal,
}: HttpRequest<T>): Promise<T | undefined> {
  let response: Response

  try {
    const binary = body instanceof Blob
    response = await fetch(buildUrl(path), {
      method,
      credentials: 'include',
      headers: {
        ...(body === undefined || binary ? {} : { 'Content-Type': 'application/json' }),
        ...(binary && body.type ? { 'Content-Type': body.type } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
      signal,
    })
  } catch (error) {
    throw new ConnectionError(error)
  }

  let responseBody: unknown

  try {
    responseBody = await readResponseBody(response)
  } catch (error) {
    throw new UnexpectedResponseError('No fue posible leer la respuesta de la API.', error, response)
  }

  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after'))
    throw new HttpError(response.status, response.statusText, responseBody, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null)
  }

  if (parse === undefined || responseBody === undefined) {
    return undefined
  }

  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new UnexpectedResponseError('La API respondió contenido no JSON donde el contrato exige JSON.', responseBody, response)
  }

  try {
    return parse(responseBody)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'La respuesta no tiene el formato esperado.'
    throw new UnexpectedResponseError(message, responseBody, response)
  }
}
