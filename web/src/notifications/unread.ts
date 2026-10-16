import { useSyncExternalStore } from 'react'

/** Total de avisos sin leer de la sesión actual; null mientras no se conoce. */
let unread: number | null = null
const listeners = new Set<() => void>()

export function setUnreadCount(value: number | null) {
  if (value === unread) return
  unread = value
  for (const listener of listeners) listener()
}

export function useUnreadCount(): number | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => unread,
  )
}
