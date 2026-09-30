import { useState } from 'react'
import { Alert } from '../components/ui/Alert'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import {
  ConnectionError,
  HttpError,
  UnexpectedResponseError,
  request,
} from '../services/http-client'

interface HealthStatus {
  status: 'ok'
}

type ConnectionState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success' }
  | { kind: 'error'; message: string }

function parseHealthStatus(body: unknown): HealthStatus {
  if (typeof body !== 'object' || body === null || !('status' in body)) {
    throw new Error('La respuesta no contiene un estado de salud válido.')
  }

  if (body.status !== 'ok') {
    throw new Error('El estado de salud recibido no es válido.')
  }

  return { status: 'ok' }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof ConnectionError) {
    return 'No fue posible conectar con el servicio. Comprueba que la API esté disponible e inténtalo nuevamente.'
  }

  if (error instanceof HttpError) {
    return 'El servicio no pudo completar la comprobación. Inténtalo nuevamente más tarde.'
  }

  if (error instanceof UnexpectedResponseError) {
    return 'El servicio respondió en un formato no esperado. Inténtalo nuevamente más tarde.'
  }

  return 'No fue posible completar la comprobación. Inténtalo nuevamente.'
}

export function ConnectionPage() {
  const [connectionState, setConnectionState] = useState<ConnectionState>({ kind: 'idle' })

  const checkConnection = async () => {
    if (connectionState.kind === 'loading') {
      return
    }

    setConnectionState({ kind: 'loading' })

    try {
      const health = await request<HealthStatus>({
        path: '/health',
        parse: parseHealthStatus,
      })

      if (health === undefined) {
        throw new UnexpectedResponseError('La respuesta de salud no contiene datos.', health)
      }

      setConnectionState({ kind: 'success' })
    } catch (error) {
      setConnectionState({ kind: 'error', message: getErrorMessage(error) })
    }
  }

  const isLoading = connectionState.kind === 'loading'
  const actionLabel = connectionState.kind === 'error' ? 'Reintentar comprobación' : 'Comprobar conexión'

  return (
    <main className="page-content">
      <Card as="section" className="content-card connection-card" aria-labelledby="connection-title">
        <p className="eyebrow">Comprobación técnica</p>
        <h1 id="connection-title">Conexión con la API</h1>
        <p>
          Esta vista consulta el endpoint de salud del backend. No afecta sesiones ni datos
          de lotes.
        </p>
        <div className="connection-actions">
          <Button
            loading={isLoading}
            onClick={() => void checkConnection()}
          >
            {isLoading ? 'Comprobando conexión…' : actionLabel}
          </Button>
        </div>
        {connectionState.kind === 'loading' && (
          <Alert className="connection-result" tone="neutral" role="status">
            Consultando el servicio…
          </Alert>
        )}
        {connectionState.kind === 'success' && (
          <Alert className="connection-result" tone="success" role="status">
            Conexión disponible: el backend respondió correctamente.
          </Alert>
        )}
        {connectionState.kind === 'error' && (
          <Alert className="connection-result" tone="danger" role="alert">
            {connectionState.message}
          </Alert>
        )}
      </Card>
    </main>
  )
}
