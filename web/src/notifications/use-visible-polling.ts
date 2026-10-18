import { useEffect, useRef } from 'react'

/** Anexos H: la bandeja consulta cada 15 s con la vista visible y recupera pendientes al volver. */
export const NOTIFICATION_POLL_MS = 15_000

/**
 * Llama a `poll` al montar, cada `intervalMs` mientras la pestaña está visible y con
 * conexión, y de inmediato al volver a la pestaña o recuperar la conexión.
 */
export function useVisiblePolling(poll: () => void, intervalMs: number, enabled = true) {
  const latest = useRef(poll)
  useEffect(() => { latest.current = poll })

  useEffect(() => {
    if (!enabled) return undefined
    const active = () => document.visibilityState === 'visible' && navigator.onLine
    const run = () => { if (active()) latest.current() }
    const timer = window.setInterval(run, intervalMs)
    const first = window.setTimeout(run, 0)
    const onVisible = () => { if (document.visibilityState === 'visible') run() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', run)
    return () => {
      window.clearInterval(timer); window.clearTimeout(first)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', run)
    }
  }, [intervalMs, enabled])
}
