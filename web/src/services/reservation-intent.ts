import type { ReserveLotRequest } from './openapi'

// Solo intención por actor/lote, nunca códigos. sessionStorage permite recuperar
// una respuesta perdida tras navegar o recargar esta pestaña.
export function intentStorageKey(actor: string, lot: string) { return `rescate:reservation:${actor}:${lot}` }
export function readIntent(storageKey: string): ReserveLotRequest | null {
  try {
    const raw = sessionStorage.getItem(storageKey)
    if (!raw) return null
    const value = JSON.parse(raw) as ReserveLotRequest
    if (Number.isSafeInteger(value.quantity) && value.quantity > 0
      && typeof value.idempotencyKey === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.idempotencyKey)) return value
  } catch { /* El almacenamiento puede estar deshabilitado. */ }
  return null
}
export function saveIntent(storageKey: string, value: ReserveLotRequest) {
  // Si no se puede conservar la intención, no se inicia un comando recuperable.
  sessionStorage.setItem(storageKey, JSON.stringify(value))
}
export function clearIntent(storageKey: string) {
  try { sessionStorage.removeItem(storageKey) } catch { /* La clave en memoria sigue siendo la misma. */ }
}
