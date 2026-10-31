import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Alert } from '../components/ui/Alert'
import { Button } from '../components/ui/Button'
import { Textarea } from '../components/ui/FormControls'
import { FormField } from '../components/ui/FormField'
import { useVisiblePolling } from '../notifications/use-visible-polling'
import { chatError, listMessages, sendMessage, type ChatMessage, type SendMessageRequest } from '../services/chat-service'
import './chat.css'

type Outgoing = SendMessageRequest & { status: 'pending' | 'failed' | 'sent'; messageId?: string; error?: string }
function Conversation({ id, csrfToken }: { id: string; csrfToken: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [outgoing, setOutgoing] = useState<Outgoing[]>([])
  const [open, setOpen] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
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
  const send = async (intent: Outgoing) => {
    if (sending.current || open !== true) return
    sending.current = true
    const life = lifecycle.current
    setOutgoing(current => current.map(item => item.idempotencyKey === intent.idempotencyKey ? { ...item, status: 'pending', error: undefined } : item))
    try {
      const result = await sendMessage(id, { text: intent.text, idempotencyKey: intent.idempotencyKey }, csrfToken)
      if (!life.active) return
      setOutgoing(current => current.map(item => item.idempotencyKey === intent.idempotencyKey ? { ...item, status: 'sent', messageId: result.id } : item))
    } catch (reason) {
      if (life.active) setOutgoing(current => current.map(item => item.idempotencyKey === intent.idempotencyKey ? { ...item, status: 'failed', error: chatError(reason) } : item))
    } finally { sending.current = false; if (life.active) void load() }
  }
  return <section aria-label="Conversación" className="chat">
    <p>Coordina el retiro con texto de hasta 1000 caracteres. Los mensajes no confirman lectura ni acreditan el retiro.</p>
    {open === null && !error && <Alert role="status">Cargando conversación…</Alert>}
    {error && <Alert tone="warning" role="status">{error}</Alert>}
    {open === false && <Alert role="status">Conversación cerrada. Puedes consultar el historial, pero ya no escribir.</Alert>}
    <ol className="chat__messages" aria-label="Mensajes">{messages.map(item => <li key={item.id} className={item.mine ? 'chat__mine' : ''}>
      <strong>{item.author === 'holder' ? 'Titular' : 'Establecimiento'}{item.mine ? ' (tú)' : ''}</strong>
      <p>{item.text}</p><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('es-CL')}</time>
    </li>)}</ol>
    <div aria-live="polite">{outgoing.filter(item => !messages.some(message => message.id === item.messageId)).map(item => <div className="chat__outgoing" key={item.idempotencyKey}>
      <p>{item.text}</p><p>{item.status === 'pending' ? 'Pendiente de confirmación…' : item.status === 'sent' ? 'Enviado al servidor' : 'Envío fallido o sin confirmar.'}</p>
      {item.error && <p>{item.error}</p>}
      {item.status === 'failed' && <Button variant="secondary" disabled={open !== true || outgoing.some(item => item.status === 'pending')} onClick={() => { void send(item) }}>Reintentar el mismo mensaje</Button>}
    </div>)}</div>
    <form onSubmit={event => {
      event.preventDefault()
      if (open !== true || sending.current || !text.trim() || [...text.trim()].length > 1000) return
      const intent: Outgoing = { text: text.trim(), idempotencyKey: crypto.randomUUID(), status: 'pending' }
      setOutgoing(current => [...current, intent]); setText(''); void send(intent)
    }}>
      <FormField label="Mensaje" hint="Entre 1 y 1000 caracteres." required>{control => <Textarea {...control} value={text} disabled={open !== true} onChange={event => setText(event.target.value)} />}</FormField>
      <Button type="submit" disabled={open !== true || !text.trim() || [...text.trim()].length > 1000 || outgoing.some(item => item.status === 'pending')}>Enviar mensaje</Button>
    </form>
    <Button variant="secondary" onClick={() => { void load() }}>Consultar conversación</Button>
  </section>
}
export function ChatPage() {
  const { id = '' } = useParams()
  const { session, csrfToken, status, error, refreshSession } = useAuth()
  const location = useLocation()
  return <main className="page-content"><div className="chat-page"><Link to="/avisos">Volver a avisos</Link><h1>Chat de la reserva</h1>
    {status === 'error' ? <Alert role="alert">{error}<Button onClick={() => { void refreshSession() }}>Reintentar sesión</Button></Alert>
      : status === 'checking' || status === 'signing-out' ? <Alert role="status">Comprobando sesión…</Alert>
      : session && csrfToken ? <Conversation key={`${session.user.id}:${id}`} id={id} csrfToken={csrfToken} />
      : <Alert>Inicia sesión para conversar. <Link to={`/login?from=${encodeURIComponent(location.pathname)}`}>Iniciar sesión</Link></Alert>}
  </div></main>
}
