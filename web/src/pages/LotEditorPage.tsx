import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { LotFormFields } from '../components/lots/LotForm'
import { LotPhotosPending } from '../components/lots/LotPhotosPending'
import { LotSummary } from '../components/lots/LotSummary'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import {
  buildDeclaration, changedFields, emptyLotValues, fieldErrorsFromIssues, hasUnsavedChanges, lotValues,
  type LotField, type LotFieldErrors, type LotFormValues,
} from '../lots/lot-form'
import { DEFAULT_TIME_ZONE } from '../lots/lot-time'
import type { OperableEstablishment } from '../services/identity-service'
import {
  ConnectionError, LotRequestError, UnexpectedResponseError,
  createLotDraft, getLot, publishLotDraft, updateLotDraft, type LotResponse,
} from '../services/lots-service'

type Operation = 'load' | 'create' | 'save' | 'publish'
type Result = { tone: 'success' | 'danger' | 'info' | 'warning'; message: string; reload?: boolean }
type Pending = 'save' | 'publish' | 'reload' | null

/** Mensajes por operación; los códigos provienen de OpenAPI y la API decide la validez. */
function resultFor(error: unknown, operation: Operation): Result {
  // Sin respuesta legible, un comando pudo haberse aplicado: se ofrece consultar el lote, sin reenviar.
  if (error instanceof ConnectionError || error instanceof UnexpectedResponseError) {
    if (operation === 'publish') return { tone: 'warning', reload: true, message: 'No se recibió una respuesta válida. El lote podría haberse publicado: recárgalo para comprobar su estado antes de reintentar.' }
    if (operation === 'save') return { tone: 'warning', reload: true, message: 'No se recibió una respuesta válida. Los cambios podrían haberse guardado: recarga el lote para comprobarlo.' }
    if (operation === 'create') return { tone: 'warning', message: 'No se recibió una respuesta válida. El borrador podría haberse creado; si vuelves a guardar se creará otro borrador.' }
    return { tone: 'danger', message: 'No fue posible conectar con el servicio. Revisa tu conexión e inténtalo nuevamente.' }
  }
  if (!(error instanceof LotRequestError)) return { tone: 'danger', message: 'No fue posible completar la solicitud. Inténtalo nuevamente más tarde.' }
  switch (error.error.code) {
    case 'VALIDATION_ERROR':
      return { tone: 'danger', message: 'Revisa los campos indicados.' }
    case 'CONFLICT':
      return { tone: 'warning', reload: true, message: 'El lote cambió desde que lo cargaste o ya fue publicado. Recarga el lote y revisa la versión actual antes de volver a intentarlo. Al recargar se descartan los cambios sin guardar.' }
    case 'UNAUTHENTICATED':
      return { tone: 'danger', message: 'Tu sesión expiró o no es válida. Inicia sesión nuevamente.' }
    case 'FORBIDDEN':
      return { tone: 'danger', message: operation === 'load'
        ? 'No tienes permiso para ver este lote.'
        : 'La solicitud fue rechazada por seguridad o permisos. Recarga la página e inténtalo nuevamente.' }
    case 'NOT_FOUND':
      return { tone: 'danger', message: operation === 'create' ? 'El establecimiento seleccionado no existe.' : 'El lote no existe o ya no está disponible.' }
    case 'RATE_LIMITED':
      return { tone: 'danger', message: 'Hay demasiadas solicitudes. Espera un momento antes de reintentar.' }
    case 'PAYLOAD_TOO_LARGE':
      return { tone: 'danger', message: 'El contenido del lote es demasiado extenso.' }
    case 'SERVICE_UNAVAILABLE':
      return { tone: 'danger', message: 'El servicio no está disponible temporalmente. Inténtalo nuevamente más tarde.' }
    default:
      return { tone: 'danger', message: 'No fue posible completar la solicitud. Inténtalo nuevamente más tarde.' }
  }
}

function ResultAlert({ result, onReload, reloading }: { result: Result; onReload: () => void; reloading: boolean }) {
  return (
    <Alert className="form-result" tone={result.tone} role={result.tone === 'danger' || result.tone === 'warning' ? 'alert' : 'status'}>
      <p>{result.message}</p>
      {result.reload && <Button className="lot-result__action" variant="secondary" loading={reloading} onClick={onReload}>{reloading ? 'Recargando…' : 'Recargar lote'}</Button>}
    </Alert>
  )
}

type EditorProps = { lotId?: string; establishments: OperableEstablishment[]; csrfToken: string }

function LotEditor({ lotId, establishments, csrfToken }: EditorProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const form = useRef<HTMLFormElement>(null)
  const busy = useRef(false)
  const [lot, setLot] = useState<LotResponse | null>(null)
  const [loadError, setLoadError] = useState<Result | null>(null)
  const [values, setValues] = useState<LotFormValues>(() => emptyLotValues(DEFAULT_TIME_ZONE))
  const [establishmentId, setEstablishmentId] = useState(establishments.length === 1 ? establishments[0].id : '')
  const [errors, setErrors] = useState<LotFieldErrors>({})
  const [result, setResult] = useState<Result | null>(() => (location.state as { notice?: string } | null)?.notice === 'created'
    ? { tone: 'success', message: 'Borrador guardado. Revísalo y publícalo cuando esté listo.' }
    : null)
  const [pending, setPending] = useState<Pending>(lotId ? 'reload' : null)
  const [confirmingPublish, setConfirmingPublish] = useState(false)

  // El aviso de creación se muestra una vez; al recargar la página no debe repetirse.
  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null })
  }, [location.pathname, location.state, navigate])

  const applyLot = (loaded: LotResponse) => {
    setLot(loaded); setValues(lotValues(loaded)); setErrors({}); setConfirmingPublish(false)
  }

  useEffect(() => {
    if (!lotId) return undefined
    const controller = new AbortController()
    getLot(lotId, controller.signal)
      .then((loaded) => { setLot(loaded); setValues(lotValues(loaded)) })
      .catch((error: unknown) => { if (!controller.signal.aborted) setLoadError(resultFor(error, 'load')) })
      .finally(() => { if (!controller.signal.aborted) setPending(null) })
    return () => controller.abort()
  }, [lotId])

  // Tras un rechazo, llevar el foco al primer campo señalado cuando el formulario ya no está bloqueado.
  useEffect(() => {
    if (pending === null && Object.keys(errors).length > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [errors, pending])

  /** Un solo comando a la vez: el ref evita dobles envíos antes de que React vuelva a renderizar. */
  const run = async (kind: Exclude<Pending, null>, action: () => Promise<void>) => {
    if (busy.current) return
    busy.current = true; setPending(kind)
    try { await action() } finally { busy.current = false; setPending(null) }
  }

  const reload = () => run('reload', async () => {
    if (!lot) return
    try {
      const loaded = await getLot(lot.id)
      applyLot(loaded)
      setResult({ tone: 'info', message: `Se cargó la versión actual del lote (versión ${loaded.version}).` })
    } catch (error) { setResult(resultFor(error, 'load')) }
  })

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void run('save', async () => {
      setResult(null); setConfirmingPublish(false)
      const built = buildDeclaration(values)
      const clientErrors: LotFieldErrors = 'errors' in built ? { ...built.errors } : {}
      if (!lot && !establishmentId) clientErrors.establishmentId = 'Selecciona el establecimiento del lote.'
      if (Object.keys(clientErrors).length > 0 || !('declaration' in built)) {
        setErrors(clientErrors); setResult({ tone: 'danger', message: 'Revisa los campos indicados.' })
        return
      }
      setErrors({})
      try {
        if (!lot) {
          const created = await createLotDraft(establishmentId, built.declaration, csrfToken)
          navigate(`/operador/lotes/${encodeURIComponent(created.id)}`, { state: { notice: 'created' } })
          return
        }
        const changes = changedFields(built.declaration, lot)
        if (Object.keys(changes).length === 0) {
          setValues(lotValues(lot)); setResult({ tone: 'info', message: 'No hay cambios para guardar.' })
          return
        }
        const updated = await updateLotDraft(lot.id, { version: lot.version, ...changes }, csrfToken)
        applyLot(updated)
        setResult({ tone: 'success', message: `Borrador guardado (versión ${updated.version}).` })
      } catch (error) {
        if (error instanceof LotRequestError) setErrors(fieldErrorsFromIssues(error.error.issues))
        setResult(resultFor(error, lot ? 'save' : 'create'))
      }
    })
  }

  const publish = () => run('publish', async () => {
    if (!lot) return
    setResult(null)
    try {
      const published = await publishLotDraft(lot.id, { version: lot.version }, csrfToken)
      applyLot(published)
      setResult({ tone: 'success', message: 'Lote publicado. Sus datos ya no se pueden modificar.' })
    } catch (error) {
      setConfirmingPublish(false)
      if (error instanceof LotRequestError) setErrors(fieldErrorsFromIssues(error.error.issues))
      setResult(resultFor(error, 'publish'))
    }
  })

  const establishmentName = (id: string) => establishments.find((item) => item.id === id)?.name ?? 'Establecimiento no disponible en tu sesión'
  const reloadButton = { onReload: () => { void reload() }, reloading: pending === 'reload' }

  if (lotId && !lot) {
    return (
      <Card as="section" className="content-card lot-card" aria-labelledby="lot-title" aria-busy={pending === 'reload'}>
        <p className="eyebrow">Operación</p>
        <h1 id="lot-title">Lote</h1>
        {loadError
          ? <><Alert className="form-result" tone={loadError.tone} role="alert">{loadError.message}</Alert>
            <Link className="text-link" to="/operador/lotes/nuevo">Crear un lote nuevo</Link></>
          : <Alert className="form-result" role="status">Cargando lote…</Alert>}
      </Card>
    )
  }

  if (lot?.status === 'published') {
    return (
      <Card as="section" className="content-card lot-card" aria-labelledby="lot-title">
        <p className="eyebrow">Operación</p>
        <div className="lot-card__title"><h1 id="lot-title">Lote publicado</h1><Badge tone="success">Publicado</Badge></div>
        <p>La cantidad, el contenido, el lugar y el plazo quedaron fijos al publicar.</p>
        {result && <ResultAlert result={result} {...reloadButton} />}
        <LotSummary lot={lot} establishmentName={establishmentName(lot.establishmentId)} />
        <LotPhotosPending />
        <Link className="text-link" to="/operador/lotes/nuevo">Crear otro lote</Link>
      </Card>
    )
  }

  const dirty = lot ? hasUnsavedChanges(values, lot) : true
  const locked = pending !== null
  const onChange = (field: LotField, value: string) => {
    setValues((current) => ({ ...current, [field]: value })); setConfirmingPublish(false)
  }

  return (
    <Card as="section" className="content-card lot-card" aria-labelledby="lot-title">
      <p className="eyebrow">Operación</p>
      <div className="lot-card__title">
        <h1 id="lot-title">{lot ? 'Borrador de lote' : 'Nuevo lote'}</h1>
        {lot && <Badge tone="info">Borrador · versión {lot.version}</Badge>}
      </div>
      <p>
        {lot
          ? `Establecimiento: ${establishmentName(lot.establishmentId)}. Guarda los cambios y publica cuando la declaración esté lista.`
          : 'Completa la declaración del lote. Se guardará como borrador y podrás revisarlo antes de publicar.'}
      </p>
      {result && <ResultAlert result={result} {...reloadButton} />}
      <form ref={form} className="lot-form" noValidate onSubmit={save} aria-busy={locked}>
        <LotFormFields
          values={values}
          errors={errors}
          disabled={locked}
          onChange={onChange}
          establishment={lot ? undefined : { options: establishments, value: establishmentId, onChange: setEstablishmentId }}
        />
        <LotPhotosPending />
        <div className="lot-actions">
          <Button type="submit" variant={lot ? 'secondary' : 'primary'} loading={pending === 'save'} disabled={locked || (lot !== null && !dirty)}>
            {pending === 'save' ? 'Guardando…' : 'Guardar borrador'}
          </Button>
          {lot && !confirmingPublish && (
            <Button loading={pending === 'publish'} disabled={locked || dirty} onClick={() => setConfirmingPublish(true)}>
              Publicar lote
            </Button>
          )}
        </div>
        {lot && dirty && <p className="lot-actions__hint">Tienes cambios sin guardar. Guarda el borrador antes de publicar.</p>}
        {lot && !dirty && !confirmingPublish && <p className="lot-actions__hint">El borrador está guardado; no hay cambios pendientes.</p>}
        {lot && confirmingPublish && (
          <Alert className="form-result" tone="warning" role="alert">
            <p>Al publicar, la cantidad, el contenido, el lugar y el plazo quedan fijos y no se podrán editar.</p>
            <div className="lot-actions">
              <Button loading={pending === 'publish'} disabled={locked} onClick={() => { void publish() }}>
                {pending === 'publish' ? 'Publicando…' : 'Confirmar publicación'}
              </Button>
              <Button variant="ghost" disabled={locked} onClick={() => setConfirmingPublish(false)}>Cancelar</Button>
            </div>
          </Alert>
        )}
      </form>
    </Card>
  )
}

export function LotEditorPage() {
  const { lotId } = useParams()
  const { pathname } = useLocation()
  const { status, session, csrfToken } = useAuth()
  const loginPath = `/login?from=${encodeURIComponent(pathname)}`

  if (status === 'checking' || status === 'error' || (!session && status === 'signing-out')) {
    return (
      <main className="page-content">
        <Card as="section" className="content-card lot-card" aria-labelledby="lot-title">
          <p className="eyebrow">Operación</p>
          <h1 id="lot-title">Publicar lote</h1>
          <Alert className="form-result" role="status">
            {status === 'error' ? 'No fue posible comprobar tu sesión. Reintenta la comprobación desde el aviso superior.' : 'Comprobando la sesión…'}
          </Alert>
        </Card>
      </main>
    )
  }

  if (!session || !csrfToken) {
    return (
      <main className="page-content">
        <Card as="section" className="content-card lot-card" aria-labelledby="lot-title">
          <p className="eyebrow">Operación</p>
          <h1 id="lot-title">Publicar lote</h1>
          <p>Para crear o publicar lotes debes iniciar sesión con una cuenta habilitada por un establecimiento.</p>
          <Link className="text-link" to={loginPath}>Iniciar sesión</Link>
        </Card>
      </main>
    )
  }

  if (session.operableEstablishments.length === 0) {
    return (
      <main className="page-content">
        <Card as="section" className="content-card lot-card" aria-labelledby="lot-title">
          <p className="eyebrow">Operación</p>
          <h1 id="lot-title">Publicar lote</h1>
          <p>
            Tu cuenta todavía no está habilitada para operar un establecimiento. La habilitación se
            gestiona por separado; el registro por sí solo no permite publicar lotes.
          </p>
        </Card>
      </main>
    )
  }

  return (
    <main className="page-content">
      <LotEditor key={lotId ?? 'nuevo'} lotId={lotId} establishments={session.operableEstablishments} csrfToken={csrfToken} />
    </main>
  )
}
