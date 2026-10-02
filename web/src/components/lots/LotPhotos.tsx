import { useRef } from 'react'
import type { LotPhoto as LotPhotoData } from '../../services/lots-service'
import { buildUrl } from '../../services/http-client'
import { ACCEPTED_PHOTO_TYPES, MAX_PHOTOS, type PhotoBusy, type PhotoNotice } from '../../lots/use-lot-photos'
import { Alert } from '../ui/Alert'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { LotPhoto } from './LotPhoto'

const rejectionMessages: Record<NonNullable<LotPhotoData['rejectionReason']>, string> = {
  unsupported_format: 'Formato no permitido. Usa JPEG, PNG o WebP.',
  animated: 'Las imágenes animadas no están permitidas.',
  too_many_pixels: 'La imagen supera los 20 megapíxeles.',
  undecodable: 'El archivo está dañado o no es una imagen válida.',
  output_too_large: 'No fue posible reducir la imagen al tamaño permitido.',
  processing_failed: 'La validación falló varias veces. Quita la foto e inténtalo con otra imagen.',
}

function PhotoState({ photo }: { photo: LotPhotoData }) {
  if (photo.status === 'ready') return <Badge tone="success">Lista</Badge>
  if (photo.status === 'rejected') return <Badge tone="danger">Rechazada</Badge>
  return <Badge tone="info">{photo.status === 'uploading' ? 'Cargando' : 'En validación'}</Badge>
}

type LotPhotosProps = {
  photos: LotPhotoData[] | null
  loadFailed: boolean
  notice: PhotoNotice | null
  /** Borrador: permite cargar y quitar. Publicado: las fotos quedan fijas. */
  editable: boolean
  busy?: PhotoBusy
  locked?: boolean
  onUpload?: (file: File) => void
  onRemove?: (photoId: string) => void
  onRetry: () => void
}

export function LotPhotos({ photos, loadFailed, notice, editable, busy = null, locked = false, onUpload, onRemove, onRetry }: LotPhotosProps) {
  const input = useRef<HTMLInputElement>(null)
  const visible = editable ? photos : photos?.filter((photo) => photo.status === 'ready') ?? null
  const full = (photos?.length ?? 0) >= MAX_PHOTOS
  const disabled = locked || busy !== null

  return (
    <Card as="section" tone="sunken" className="lot-photos" aria-labelledby="lot-photos-title" aria-busy={busy !== null}>
      <div className="lot-photos__header">
        <h2 id="lot-photos-title">{editable ? 'Fotos (opcional)' : 'Fotos'}</h2>
        {photos && <span className="lot-photos__count">{photos.length} de {MAX_PHOTOS}</span>}
      </div>
      <p>
        {editable
          ? 'Hasta tres fotos JPEG, PNG o WebP de máximo 5 MiB. Se validan antes de mostrarse y quedan fijas al publicar. Puedes publicar sin fotos.'
          : 'Las fotos quedaron fijas al publicar.'}
      </p>
      {notice && <Alert tone={notice.tone} role={notice.tone === 'info' ? 'status' : 'alert'}>{notice.message}</Alert>}
      {loadFailed && (
        <Alert tone="danger" role="alert">
          <p>No fue posible consultar las fotos.</p>
          <Button className="lot-result__action" variant="secondary" onClick={onRetry}>Reintentar</Button>
        </Alert>
      )}
      {visible === null && !loadFailed && <p role="status">Cargando fotos…</p>}
      {visible && visible.length === 0 && !editable && <p>Este lote no tiene fotos.</p>}
      {visible && visible.length > 0 && (
        <ul className="lot-photo-grid">
          {visible.map((photo) => (
            <li key={photo.id} className="lot-photo-item">
              {photo.status === 'ready' && photo.thumbnailUrl
                ? <LotPhoto src={buildUrl(photo.thumbnailUrl)} description={`Foto ${photo.position} del lote`} />
                : <div className="lot-photo lot-photo-item__placeholder" aria-hidden="true" />}
              <div className="lot-photo-item__meta">
                <span>Foto {photo.position}</span>
                <PhotoState photo={photo} />
              </div>
              {photo.status === 'rejected' && photo.rejectionReason && (
                <p className="lot-photo-item__reason">{rejectionMessages[photo.rejectionReason]}</p>
              )}
              {editable && (
                <Button
                  variant="ghost"
                  loading={busy?.kind === 'remove' && busy.photoId === photo.id}
                  disabled={disabled}
                  aria-label={`Quitar foto ${photo.position}`}
                  onClick={() => onRemove?.(photo.id)}
                >
                  Quitar
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && photos && !full && (
        <div className="lot-photos__actions">
          <input
            ref={input}
            className="visually-hidden"
            type="file"
            name="photo"
            accept={ACCEPTED_PHOTO_TYPES.join(',')}
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) onUpload?.(file)
            }}
          />
          <Button variant="secondary" loading={busy?.kind === 'upload'} disabled={disabled} onClick={() => input.current?.click()}>
            {busy?.kind === 'upload' ? 'Cargando foto…' : 'Agregar foto'}
          </Button>
        </div>
      )}
    </Card>
  )
}
