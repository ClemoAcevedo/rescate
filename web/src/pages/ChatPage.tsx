import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Alert } from '../components/ui/Alert'
import { Button } from '../components/ui/Button'
import { Textarea } from '../components/ui/FormControls'
import { FormField } from '../components/ui/FormField'
import { Skeleton } from '../components/ui/Skeleton'
import { RecordSkeleton } from '../components/RecordSkeleton'
import { Icon } from '../components/Icon'
import { lotTitle } from '../lots/lot-title'
import { useVisiblePolling } from '../notifications/use-visible-polling'
import { chatError, listMessages, sendMessage, type ChatMessage, type SendMessageRequest } from '../services/chat-service'
import './chat.css'
import { DEFAULT_TIME_ZONE, formatInstant } from '../format/date-time'

function subscribeConnection(update: () => void) {
  window.addEventListener('online', update)
  window.addEventListener('offline', update)
  return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
}
const isOnline = () => navigator.onLine

const MAX_LENGTH = 1000
// El autor se nombra desde quien mira, sin revelar qué operador escribió
const authorLabel = (item: ChatMessage) => item.mine ? 'Tú' : item.author === 'holder' ? 'Persona que reservó' : 'Establecimiento'

type Outgoing = SendMessageRequest & { status: 'pending' | 'failed' | 'sent'; messageId?: string; error?: string }
function Conversation({ id, csrfToken }: { id: string; csrfToken: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [outgoing, setOutgoing] = useState<Outgoing[]>([])
  const [open, setOpen] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const online = useSyncExternalStore(subscribeConnection, isOnline)
  const editor = useRef<HTMLTextAreaElement>(null)
  const cursor = useRef(0)
  const fetching = useRef(false)
  const sending = useRef(false)
  const lifecycle = useRef({ active: true })
  useEffect(() => {
    const life = { active: true }; lifecycle.current = life
    return () => { life.active = false }
  }, [])
  const load = useCallback(async () => {
    if (fetching.current) return
    fetching.current = true
    const life = lifecycle.current
    try {
      let more = true
      while (more && life.active && document.visibilityState === 'visible' && navigator.onLine) {
        const page = await listMessages(id, cursor.current, AbortSignal.timeout(10000))
        if (!life.active) return
        setOpen(current => current === false ? false : page.open)
        setMessages(current => {
          const byId = new Map(current.map(item => [item.id, item]))
          page.items.forEach(item => byId.set(item.id, item))
          return [...byId.values()].sort((a, b) => a.sequence - b.sequence)
        })
        // Only GET advances the cursor: POST may overtake messages still missing locally.
        if (page.items.length) cursor.current = page.items.at(-1)!.sequence
        more = page.hasMore
      }
      if (life.active) setError(null)
    } catch (reason) { if (life.active) setError(chatError(reason)) }
    finally { fetching.current = false }
  }, [id])
  useVisiblePolling(() => { void load() }, 5000)
  const send = async (intent: Outgoing, restoreFocus = false) => {
    const trigger = restoreFocus ? document.activeElement : null
    if (sending.current || open !== true) return
    sending.current = true
    const life = lifecycle.current
    setOutgoing(current => current.map(item => item.idempotencyKey === intent.idempotencyKey ? { ...item, status: 'pending', error: undefined } : item))
    try {
      const result = await sendMessage(id, { text: intent.text, idempotencyKey: intent.idempotencyKey }, csrfToken)
      if (!life.active) return
      setOutgoing(current => current.map(item => item.idempotencyKey === intent.idempotencyKey ? { ...item, status: 'sent', messageId: result.id } : item))
      if (trigger && (document.activeElement === trigger || document.activeElement === document.body)) editor.current?.focus()
    } catch (reason) {
      if (life.active) setOutgoing(current => current.map(item => item.idempotencyKey === intent.idempotencyKey ? { ...item, status: 'failed', error: chatError(reason) } : item))
    } finally { sending.current = false; if (life.active) void load() }
  }
  const length = [...text.trim()].length
  const tooLong = length > MAX_LENGTH
  const pending = outgoing.some(item => item.status === 'pending')
  return <section aria-label="Conversación" className="chat">
    <div className="chat__toolbar">
      <p className="chat__zone">Horarios en {DEFAULT_TIME_ZONE}</p>
      <Button variant="ghost" className="chat__refresh" onClick={() => { void load() }}>Actualizar</Button>
    </div>
    {!online && <Alert tone="warning" role="status">Sin conexión. Tus mensajes se mantienen aquí y se actualizan al reconectar.</Alert>}
    {online && open === null && !error && <span className="visually-hidden" role="status">Cargando conversación…</span>}
    {error && <Alert tone="warning" role="status">{error}</Alert>}
    {open === false && <Alert role="status">Conversación cerrada. Puedes leer el historial, pero ya no escribir.</Alert>}
    <ol className="chat__messages" role="log" aria-label="Mensajes" aria-relevant="additions" aria-busy={online && open === null && !error}>
      {online && open === null && !error && [0, 1].map(index => <li key={index} className={`chat__bubble${index ? ' chat__mine' : ''}`} aria-hidden="true"><span className="chat__author"><Skeleton width="5rem" /></span><p><Skeleton width="12rem" /></p></li>)}
      {open !== null && messages.length === 0 && <li className="chat__empty">Aún no hay mensajes.</li>}
      {messages.map(item => <li key={item.id} className={`chat__bubble${item.mine ? ' chat__mine' : ''}`}>
        <span className="chat__author">{authorLabel(item)}</span>
        <p>{item.text}</p>
        <time dateTime={item.createdAt}>{formatInstant(item.createdAt, DEFAULT_TIME_ZONE)}</time>
      </li>)}
    </ol>
    <div className="chat__outbox" aria-live="polite">{outgoing.filter(item => !messages.some(message => message.id === item.messageId)).map(item => <div className={`chat__bubble chat__mine chat__outgoing chat__outgoing--${item.status}`} key={item.idempotencyKey}>
      <span className="chat__author">Tú</span>
      <p>{item.text}</p>
      <span className="chat__status">{item.status === 'pending' ? 'Enviando…' : item.status === 'sent' ? 'Enviado' : 'No se pudo enviar'}</span>
      {item.error && <span className="chat__error">{item.error}</span>}
      {item.status === 'failed' && <Button variant="secondary" disabled={open !== true || pending} onClick={() => { void send(item, true) }}>Reintentar</Button>}
    </div>)}</div>
    <form className="chat__composer" onSubmit={event => {
      event.preventDefault()
      if (open !== true || sending.current || !text.trim() || tooLong) return
      const intent: Outgoing = { text: text.trim(), idempotencyKey: crypto.randomUUID(), status: 'pending' }
      setOutgoing(current => [...current, intent]); setText(''); void send(intent)
    }}>
      <FormField label="Mensaje" required hint={`${length}/${MAX_LENGTH}`} error={tooLong ? `${length}/${MAX_LENGTH}, máximo ${MAX_LENGTH} caracteres.` : undefined}>{control => <Textarea {...control} ref={editor} rows={3} value={text} disabled={open !== true} onChange={event => setText(event.target.value)} />}</FormField>
      <Button type="submit" disabled={open !== true || !text.trim() || tooLong || pending}>Enviar mensaje</Button>
    </form>
  </section>
}

type Viewer = 'holder' | 'operator' | null
// Estado que pueden pasar los links que abren el chat, para dar contexto sin pedir más datos a la API
type ChatState = { lotDescription?: unknown; viewer?: unknown; from?: unknown } | null
// Solo se vuelve a rutas conocidas, nunca a un destino arbitrario guardado en el historial
const backLabel = (path: string) => path === '/avisos' ? 'Volver a avisos'
  : path === '/operador/panel' || path.startsWith('/operador/panel?') ? 'Volver al panel' : null

export function ChatPage() {
  const { id = '' } = useParams()
  const { session, csrfToken, status, error, refreshSession } = useAuth()
  const location = useLocation()
  const state = (location.state ?? null) as ChatState
  const lot = typeof state?.lotDescription === 'string' ? lotTitle(state.lotDescription) : null
  // Sin establecimientos a cargo solo se puede ser quien reservó
  const viewer: Viewer = state?.viewer === 'holder' || state?.viewer === 'operator' ? state.viewer
    : session && session.operableEstablishments.length === 0 ? 'holder' : null
  const from = typeof state?.from === 'string' && backLabel(state.from) ? state.from : null
  const back = viewer === 'holder' ? { to: `/reservas/${encodeURIComponent(id)}`, label: 'Volver a la reserva' }
    : from ? { to: from, label: backLabel(from)! }
    : viewer === 'operator' ? { to: '/operador/panel', label: 'Volver al panel' }
    : { to: '/avisos', label: 'Volver a avisos' }
  const counterpart = viewer === 'holder' ? 'Con el establecimiento' : viewer === 'operator' ? 'Con la persona que reservó' : null
  return <main className="page-content"><div className="chat-page">
    <Link className="back-link" to={back.to}><Icon name="arrowLeft" />{back.label}</Link>
    <header className="chat-page__header">
      <p className="eyebrow">Chat de la reserva</p>
      <h1>{lot ?? (counterpart ? `Chat ${counterpart.toLowerCase()}` : 'Conversación de la reserva')}</h1>
      {lot && counterpart && <p className="chat-page__with">{counterpart}</p>}
    </header>
    {status === 'error' ? <Alert role="alert">{error}<Button onClick={() => { void refreshSession() }}>Reintentar sesión</Button></Alert>
      : status === 'checking' || status === 'signing-out' ? <RecordSkeleton label="Comprobando sesión…" />
      : session && csrfToken ? <Conversation key={`${session.user.id}:${id}`} id={id} csrfToken={csrfToken} />
      : <Alert>Inicia sesión para conversar. <Link to={`/login?from=${encodeURIComponent(location.pathname)}`}>Iniciar sesión</Link></Alert>}
  </div></main>
}
