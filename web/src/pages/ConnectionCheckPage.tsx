import { useState } from 'react'
import { checkHealth } from '../services/healthCheck'
import './Page.css'

type ConnectionState = 'idle' | 'loading' | 'success' | 'error'

export function ConnectionCheckPage() {
  const [state, setState] = useState<ConnectionState>('idle')

  async function handleConnectionCheck() {
    if (state === 'loading') {
      return
    }

    setState('loading')

    try {
      await checkHealth()
      setState('success')
    } catch {
      setState('error')
    }
  }

  const isLoading = state === 'loading'
  const buttonLabel = state === 'error' ? 'Reintentar conexión' : 'Consultar conexión'

  return (
    <section className="page" aria-labelledby="connection-title">
      <p className="page__eyebrow">Comprobación técnica</p>
      <h1 id="connection-title">Conexión con el backend</h1>
      <p className="page__description">
        Esta herramienta consulta el endpoint de salud del backend. No forma parte
        del recorrido principal ni envía datos de usuarios.
      </p>
      <button
        className="page__button"
        type="button"
        disabled={isLoading}
        onClick={handleConnectionCheck}
      >
        {isLoading ? 'Consultando conexión…' : buttonLabel}
      </button>
      <div className="connection-status" aria-live="polite">
        {state === 'idle' && <p>La comprobación aún no se ha ejecutado.</p>}
        {state === 'loading' && <p>Comprobando disponibilidad del backend…</p>}
        {state === 'success' && (
          <p className="connection-status__success">
            Conexión confirmada: el backend respondió correctamente.
          </p>
        )}
        {state === 'error' && (
          <p className="connection-status__error" role="alert">
            No fue posible comprobar la conexión. Verifica que el backend esté
            disponible e inténtalo nuevamente.
          </p>
        )}
      </div>
    </section>
  )
}
