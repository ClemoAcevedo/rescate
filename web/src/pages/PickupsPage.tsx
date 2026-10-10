import './pickups.css'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/FormControls'
import { FormField } from '../components/ui/FormField'
import { formatInstant, formatWindow } from '../lots/lot-time'
import { lotTitle } from '../lots/lot-title'
import { HttpError } from '../services/http-client'
import { LotRequestError, getLot, type LotResponse } from '../services/lots-service'
import {
  confirmPickup, isUnknownOutcome, pickupError, reviewPickupCode,
  type PickupResponse, type ReviewedReservation,
} from '../services/reservations-service'

type Notice = { tone: 'danger' | 'warning' | 'info'; text: string }
/** El código vive solo aquí, en memoria, mientras se decide la entrega: nunca en URL ni almacenamiento. */
type Review = { reservation: ReviewedReservation; canConfirm: boolean; code: string; idempotencyKey: string }
type Phase = 'idle' | 'reviewing' | 'confirming'

const statusBadges = {
  confirmed: { label: 'Confirmada', tone: 'success' },
  cancelled: { label: 'Cancelada', tone: 'danger' },
  expired: { label: 'Vencida', tone: 'neutral' },
  delivered: { label: 'Retirada', tone: 'info' },
} as const

const packs = (quantity: number) => `${quantity} ${quantity === 1 ? 'pack' : 'packs'}`

function lotLoadError(error: unknown): string {
  if (error instanceof LotRequestError && error.status === 403) return 'Acceso denegado: tu cuenta no opera el establecimiento de este lote.'
  if (error instanceof LotRequestError && error.status === 404) return 'El lote no existe o ya no está disponible.'
  if (error instanceof LotRequestError && error.status === 401) return 'Tu sesión venció. Inicia sesión nuevamente.'
  return 'No fue posible cargar el lote. Revisa tu conexión y reintenta.'
}

/** Explica qué significa el estado revisado para la entrega; el backend es quien decide al confirmar. */
function ReviewOutcome({ review, lot }: { review: Review; lot: LotResponse }) {
  const { reservation, canConfirm } = review
  const ended = reservation.endedAt ? formatInstant(reservation.endedAt, lot.timeZone) : ''
  if (reservation.status === 'cancelled') return <Alert tone="danger" role="alert">El titular canceló esta reserva ({ended}). No se puede entregar.</Alert>
  if (reservation.status === 'expired') return <Alert tone="warning" role="alert">La reserva venció: el lote cerró ({ended}) sin retiro. No se puede entregar.</Alert>
  if (reservation.status === 'delivered') return <Alert tone="info" role="status">Esta reserva ya se retiró ({ended}). El código ya fue usado.</Alert>
  if (!canConfirm) {
    return <Alert tone="warning" role="status">La ventana de retiro aún no comienza. Podrás confirmar desde {formatInstant(lot.pickupStartsAt, lot.timeZone)}.</Alert>
  }
  return <Alert tone="info" role="status">La reserva está vigente. Entrega {packs(reservation.quantity)} completos y confirma el retiro.</Alert>
}

function PickupDesk({ lot, csrfToken }: { lot: LotResponse; csrfToken: string }) {
  const [code, setCode] = useState('')
  const [review, setReview] = useState<Review | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [delivered, setDelivered] = useState<PickupResponse | null>(null)
  const [unknownOutcome, setUnknownOutcome] = useState(false)
  const busy = useRef(false)
  const codeInput = useRef<HTMLInputElement>(null)

  /** Un comando a la vez: el ref evita dobles envíos antes del siguiente render. */
  const run = async (next: Exclude<Phase, 'idle'>, action: () => Promise<void>) => {
    if (busy.current) return
    busy.current = true; setPhase(next)
    try { await action() } finally { busy.current = false; setPhase('idle') }
  }

  const reviewCode = (value: string) => run('reviewing', async () => {
    setNotice(null); setDelivered(null); setUnknownOutcome(false)
    try {
      const result = await reviewPickupCode(lot.id, value, csrfToken)
      setReview({ ...result, code: value, idempotencyKey: crypto.randomUUID() })
      setCode('')
    } catch (error) {
      setReview(null)
      setNotice({ tone: 'danger', text: pickupError(error, 'review') })
    }
  })

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!code.trim()) { setNotice({ tone: 'danger', text: 'Escribe el código de retiro que muestra la persona.' }); return }
    void reviewCode(code.trim())
  }

  const confirm = () => run('confirming', async () => {
    if (!review) return
    setNotice(null)
    try {
      const result = await confirmPickup(lot.id, {
        reservationId: review.reservation.id, code: review.code, idempotencyKey: review.idempotencyKey,
      }, csrfToken)
      setDelivered(result); setReview(null); setUnknownOutcome(false)
      codeInput.current?.focus()
    } catch (error) {
      if (isUnknownOutcome(error)) {
        // Misma clave al reintentar: si la entrega se registró, la API reproduce el 201 original.
        setUnknownOutcome(true)
        setNotice({ tone: 'warning', text: pickupError(error, 'confirm') })
        return
      }
      if (error instanceof HttpError && error.status === 409) {
        // Confirmar relee el estado bajo bloqueo; revisar de nuevo muestra qué cambió (p. ej. una cancelación).
        try {
          const current = await reviewPickupCode(lot.id, review.code, csrfToken)
          setReview({ ...current, code: review.code, idempotencyKey: crypto.randomUUID() })
          setNotice({ tone: 'warning', text: 'La reserva cambió desde la revisión y no se registró la entrega. Este es su estado actual.' })
        } catch (reviewFailure) {
          setReview(null)
          setNotice({ tone: 'danger', text: pickupError(reviewFailure, 'review') })
        }
        return
      }
      setNotice({ tone: 'danger', text: pickupError(error, 'confirm') })
    }
  })

  const reset = () => {
    setReview(null); setNotice(null); setDelivered(null); setUnknownOutcome(false); setCode('')
    codeInput.current?.focus()
  }

  const locked = phase !== 'idle'
  const badge = review ? statusBadges[review.reservation.status] : null

  return (
    <div className="pickups__desk">
      <form className="pickups__form" noValidate onSubmit={submit} aria-busy={phase === 'reviewing'}>
        <FormField label="Código de retiro" hint="Ocho caracteres. Mayúsculas, espacios y guiones no importan." required>
          {(control) => (
            <Input
              {...control}
              ref={codeInput}
              name="pickupCode"
              className="pickups__code"
              value={code}
              maxLength={32}
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              disabled={locked}
              onChange={(event) => setCode(event.target.value)}
            />
          )}
        </FormField>
        <Button type="submit" variant="secondary" loading={phase === 'reviewing'} disabled={locked}>
          {phase === 'reviewing' ? 'Revisando…' : 'Revisar código'}
        </Button>
      </form>

      {notice && <Alert tone={notice.tone} role={notice.tone === 'info' ? 'status' : 'alert'}>{notice.text}</Alert>}

      {delivered && (
        <Alert tone="success" role="status">
          Retiro registrado: {packs(delivered.quantity)} entregados ({formatInstant(delivered.deliveredAt, lot.timeZone)}).
        </Alert>
      )}

      {review && badge && (
        <Card as="section" className="pickups__review" aria-labelledby="pickup-review-title">
          <div className="pickups__review-heading">
            <h2 id="pickup-review-title">Reserva revisada</h2>
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </div>
          <dl className="pickups__facts">
            <div><dt>Cantidad</dt><dd>{packs(review.reservation.quantity)}</dd></div>
            <div><dt>Reservada</dt><dd>{formatInstant(review.reservation.createdAt, lot.timeZone)}</dd></div>
            {review.reservation.endedAt && <div><dt>Terminó</dt><dd>{formatInstant(review.reservation.endedAt, lot.timeZone)}</dd></div>}
          </dl>
          <ReviewOutcome review={review} lot={lot} />
          <div className="pickups__actions">
            {review.canConfirm && (
              <Button loading={phase === 'confirming'} disabled={locked} onClick={() => { void confirm() }}>
                {phase === 'confirming' ? 'Confirmando…' : unknownOutcome ? 'Reintentar confirmación' : `Confirmar retiro de ${packs(review.reservation.quantity)}`}
              </Button>
            )}
            <Button variant="ghost" disabled={locked} onClick={reset}>Revisar otro código</Button>
          </div>
        </Card>
      )}
    </div>
  )
}

function LotHeader({ lot, now }: { lot: LotResponse; now: number }) {
  const closed = lot.status === 'expired' || lot.status === 'withdrawn' || Date.parse(lot.pickupEndsAt) <= now
  const notStarted = !closed && Date.parse(lot.pickupStartsAt) > now
  return (
    <>
      <p className="eyebrow">Operación</p>
      <h1 id="pickups-title">Validar retiros</h1>
      <p className="pickups__lot"><strong>{lotTitle(lot.description)}</strong> · {formatWindow(lot.pickupStartsAt, lot.pickupEndsAt, lot.timeZone)} ({lot.timeZone})</p>
      {lot.status === 'draft' && <Alert tone="warning" role="status">El lote aún no está publicado: todavía no tiene reservas.</Alert>}
      {closed && lot.status !== 'draft' && (
        <Alert tone="warning" role="status">El lote está cerrado: la ventana de retiro terminó. Puedes revisar códigos, pero ya no se confirman entregas.</Alert>
      )}
      {notStarted && <Alert tone="info" role="status">La ventana de retiro comienza {formatInstant(lot.pickupStartsAt, lot.timeZone)}. Antes de eso puedes revisar códigos, pero no confirmar.</Alert>}
    </>
  )
}

function Pickups({ lotId, csrfToken }: { lotId: string; csrfToken: string }) {
  const [lot, setLot] = useState<LotResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [openedAt] = useState(() => Date.now())

  useEffect(() => {
    const controller = new AbortController()
    getLot(lotId, controller.signal)
      .then((loaded) => { if (!controller.signal.aborted) { setLot(loaded); setError(null) } })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(lotLoadError(reason)) })
    return () => controller.abort()
  }, [lotId, retry])

  if (error) {
    return (
      <>
        <p className="eyebrow">Operación</p>
        <h1 id="pickups-title">Validar retiros</h1>
        <Alert tone="danger" role="alert">
          <p>{error}</p>
          <Button variant="secondary" onClick={() => { setError(null); setRetry((value) => value + 1) }}>Reintentar</Button>
        </Alert>
        <Link className="text-link" to="/operador/lotes">Volver a mis lotes</Link>
      </>
    )
  }
  if (!lot) return <><h1 id="pickups-title">Validar retiros</h1><Alert role="status">Cargando lote…</Alert></>
  return (
    <>
      <LotHeader lot={lot} now={openedAt} />
      {lot.status !== 'draft' && <PickupDesk lot={lot} csrfToken={csrfToken} />}
      <div className="pickups__footer">
        <Link className="ui-button ui-button--secondary" to={`/operador/lotes/${encodeURIComponent(lot.id)}`}>Ver lote</Link>
        <Link className="ui-button ui-button--ghost" to="/operador/lotes">Volver a mis lotes</Link>
      </div>
    </>
  )
}

export function PickupsPage() {
  const { lotId = '' } = useParams()
  const { pathname } = useLocation()
  const { status, session, csrfToken } = useAuth()
  let content
  if (status === 'checking' || status === 'error' || (!session && status === 'signing-out')) {
    content = <><h1 id="pickups-title">Validar retiros</h1><Alert role="status">{status === 'error' ? 'No fue posible comprobar tu sesión. Reintenta desde el aviso superior.' : 'Comprobando la sesión…'}</Alert></>
  } else if (!session || !csrfToken) {
    content = <><h1 id="pickups-title">Validar retiros</h1><p>Inicia sesión con una cuenta habilitada por el establecimiento para validar retiros.</p>
      <Link className="text-link" to={`/login?from=${encodeURIComponent(pathname)}`}>Iniciar sesión</Link></>
  } else {
    // La clave por usuario evita mezclar una revisión en curso si cambia la sesión.
    content = <Pickups key={`${session.user.id}:${lotId}`} lotId={lotId} csrfToken={csrfToken} />
  }
  return <main className="page-content"><Card as="section" className="content-card pickups" aria-labelledby="pickups-title">{content}</Card></main>
}
