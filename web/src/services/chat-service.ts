import { HttpError, UnexpectedResponseError, request } from './http-client'
import type { ChatMessage, ChatMessagePage, SendMessageRequest, SentMessage } from './openapi'
export type { ChatMessage, SendMessageRequest }
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
function sent(v: unknown): SentMessage {
  if (!record(v) || typeof v.id !== 'string' || !v.id || !Number.isSafeInteger(v.sequence)
    || Number(v.sequence) < 1 || Number(v.sequence) > 2147483647 || typeof v.createdAt !== 'string'
    || !Number.isFinite(Date.parse(v.createdAt))) throw new Error('Mensaje inesperado.')
  return { id: v.id, sequence: v.sequence as number, createdAt: v.createdAt }
}
export async function listMessages(id: string, after: number, signal: AbortSignal): Promise<ChatMessagePage> {
  const result = await request({ path: `/reservations/${encodeURIComponent(id)}/messages?after=${after}`, signal, parse: v => {
    if (!record(v) || !Array.isArray(v.items) || v.items.length > 50 || typeof v.open !== 'boolean'
      || typeof v.hasMore !== 'boolean' || (v.hasMore && !v.items.length)) throw new Error('Conversación inesperada.')
    let previous = after
    const items = v.items.map((item: unknown): ChatMessage => {
      const base = sent(item)
      if (!record(item) || base.sequence <= previous || !['holder', 'operator'].includes(String(item.author))
        || typeof item.mine !== 'boolean' || typeof item.text !== 'string' || !item.text.trim() || [...item.text].length > 1000) throw new Error('Conversación inesperada.')
      previous = base.sequence
      return { ...base, author: item.author as ChatMessage['author'], mine: item.mine, text: item.text }
    })
    return { items, hasMore: v.hasMore, open: v.open }
  } })
  if (!result) throw new UnexpectedResponseError('Conversación vacía.', undefined)
  return result
}
export async function sendMessage(id: string, body: SendMessageRequest, csrfToken: string) {
  const result = await request({ path: `/reservations/${encodeURIComponent(id)}/messages`, method: 'POST', body,
    headers: { 'X-CSRF-Token': csrfToken }, signal: AbortSignal.timeout(10000), parse: sent })
  if (!result) throw new UnexpectedResponseError('Envío sin confirmar.', undefined)
  return result
}
export function chatError(error: unknown) {
  if (error instanceof HttpError) {
    if (error.status === 401) return 'Tu sesión venció. Inicia sesión nuevamente.'
    if (error.status === 403) return 'Solicitud rechazada por seguridad. Recarga la página.'
    if (error.status === 404) return 'La conversación no existe o no pertenece a tu cuenta.'
    if (error.status === 409) return 'No se pudo enviar: la conversación cerró o la clave ya fue utilizada. Consulta el estado actualizado.'
    if (error.status === 429) return `Demasiados envíos. Espera ${error.retryAfter ?? 60} segundos antes de reintentar.`
    if (error.status === 422) return 'El mensaje debe tener entre 1 y 1000 caracteres.'
  }
  return 'No se recibió confirmación. Revisa tu conexión; el historial se recuperará al reconectar.'
}
