import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ConnectionError, LotRequestError, UnexpectedResponseError,
  listLotPhotos, removeLotPhoto, uploadLotPhoto, type LotPhoto,
} from '../services/lots-service'

export const MAX_PHOTOS = 3
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024
export const ACCEPTED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
/** Mientras haya fotos en carga o validación se consulta la lista; 20/min queda dentro del límite por usuario. */
const POLL_MS = 3000

export type PhotoNotice = { tone: 'danger' | 'warning' | 'info'; message: string }
export type PhotoBusy = { kind: 'upload' } | { kind: 'remove'; photoId: string } | null

export const isSettled = (photo: LotPhoto) => photo.status === 'ready'
const isProcessing = (photo: LotPhoto) => photo.status === 'uploading' || photo.status === 'pending'

/** Comprobación previa solo para avisar antes de enviar; la API valida firma, tamaño y contenido. */
export function precheckPhoto(file: File): string | null {
  if (!ACCEPTED_PHOTO_TYPES.includes(file.type)) return 'Usa una imagen JPEG, PNG o WebP.'
  if (file.size > MAX_PHOTO_BYTES) return 'La imagen supera el máximo de 5 MiB.'
  return null
}

function uploadNotice(error: unknown): PhotoNotice {
  // Sin respuesta legible la foto pudo quedar cargada: se consulta la lista, sin reenviar (OpenAPI).
  if (error instanceof ConnectionError || error instanceof UnexpectedResponseError) {
    return { tone: 'warning', message: 'No se recibió una respuesta válida. La foto podría haberse cargado; revisa la lista antes de volver a intentarlo.' }
  }
  if (!(error instanceof LotRequestError)) return { tone: 'danger', message: 'No fue posible cargar la foto. Inténtalo nuevamente.' }
  switch (error.error.code) {
    case 'PAYLOAD_TOO_LARGE': return { tone: 'danger', message: 'La imagen supera el máximo de 5 MiB.' }
    case 'UNSUPPORTED_MEDIA_TYPE': return { tone: 'danger', message: 'Usa una imagen JPEG, PNG o WebP.' }
    case 'VALIDATION_ERROR': return { tone: 'danger', message: 'El archivo no es una imagen JPEG, PNG o WebP válida.' }
    case 'CONFLICT': return { tone: 'warning', message: 'No se pudo agregar la foto: el lote ya tiene tres fotos, fue publicado o la carga venció. Se actualizó la lista.' }
    case 'RATE_LIMITED': return {
      tone: 'warning',
      message: `Ya tienes dos cargas en curso o demasiadas solicitudes. Espera${error.retryAfter ? ` ${error.retryAfter} s` : ' un momento'} antes de cargar otra foto.`,
    }
    case 'SERVICE_UNAVAILABLE': return { tone: 'danger', message: 'La carga de fotos no está disponible en este momento. Puedes guardar y publicar el lote sin fotos.' }
    case 'UNAUTHENTICATED': return { tone: 'danger', message: 'Tu sesión expiró o no es válida. Inicia sesión nuevamente.' }
    case 'FORBIDDEN': return { tone: 'danger', message: 'La solicitud fue rechazada por seguridad o permisos. Recarga la página e inténtalo nuevamente.' }
    default: return { tone: 'danger', message: 'No fue posible cargar la foto. Inténtalo nuevamente.' }
  }
}

function removeNotice(error: unknown): PhotoNotice {
  if (error instanceof LotRequestError && (error.error.code === 'CONFLICT' || error.error.code === 'NOT_FOUND')) {
    return { tone: 'warning', message: 'La foto ya no se puede quitar: el lote fue publicado o la foto ya no existe. Se actualizó la lista.' }
  }
  if (error instanceof LotRequestError && error.error.code === 'RATE_LIMITED') {
    return { tone: 'warning', message: 'Hay demasiadas solicitudes. Espera un momento antes de reintentar.' }
  }
  return { tone: 'danger', message: 'No fue posible quitar la foto. Revisa la lista e inténtalo nuevamente.' }
}

/**
 * Estado de las fotos de un lote del operador, con consulta periódica mientras el worker valida.
 * Sin `lotId` (lote aún no guardado o no cargado) no consulta nada.
 */
export function useLotPhotos(lotId: string | undefined, csrfToken: string, { poll }: { poll: boolean }) {
  const [photos, setPhotos] = useState<LotPhoto[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [notice, setNotice] = useState<PhotoNotice | null>(null)
  const [busy, setBusy] = useState<PhotoBusy>(null)
  const busyRef = useRef(false)
  const mounted = useRef(true)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!lotId) return
    try {
      const items = await listLotPhotos(lotId, signal)
      if (!signal?.aborted && mounted.current) { setPhotos(items); setLoadFailed(false) }
    } catch {
      if (!signal?.aborted && mounted.current) setLoadFailed(true)
    }
  }, [lotId])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    // Diferido como en AuthProvider: la primera consulta no actualiza estado dentro del efecto.
    void Promise.resolve().then(() => refresh(controller.signal))
    return () => { mounted.current = false; controller.abort() }
  }, [refresh])

  const processing = photos?.some(isProcessing) ?? false
  useEffect(() => {
    if (!poll || !processing) return undefined
    const timer = window.setTimeout(() => { void refresh() }, POLL_MS)
    return () => window.clearTimeout(timer)
  }, [poll, processing, photos, refresh])

  /** Una operación a la vez: el ref evita dobles envíos antes del siguiente render. */
  const run = async (next: Exclude<PhotoBusy, null>, action: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(next); setNotice(null)
    try { await action() } finally { busyRef.current = false; if (mounted.current) setBusy(null) }
  }

  const upload = (file: File) => run({ kind: 'upload' }, async () => {
    if (!lotId) return
    const problem = precheckPhoto(file)
    if (problem) { setNotice({ tone: 'danger', message: problem }); return }
    try {
      const photo = await uploadLotPhoto(lotId, file, csrfToken)
      setPhotos((current) => [...(current ?? []).filter((item) => item.id !== photo.id), photo].sort((a, b) => a.position - b.position))
      setNotice({ tone: 'info', message: 'Foto recibida. Se está validando; aparecerá su miniatura cuando esté lista.' })
    } catch (error) {
      setNotice(uploadNotice(error))
      await refresh()
    }
  })

  const remove = (photoId: string) => run({ kind: 'remove', photoId }, async () => {
    if (!lotId) return
    try {
      await removeLotPhoto(lotId, photoId, csrfToken)
      setPhotos((current) => (current ?? []).filter((item) => item.id !== photoId))
    } catch (error) {
      setNotice(removeNotice(error))
      await refresh()
    }
  })

  // «Foto recibida, se está validando» deja de tener sentido cuando ya no hay fotos en proceso.
  const visibleNotice = notice?.tone === 'info' && !processing ? null : notice
  return { photos, loadFailed, notice: visibleNotice, busy, refresh, upload, remove }
}
