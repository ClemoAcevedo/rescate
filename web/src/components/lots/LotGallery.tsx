import { useState } from 'react'
import type { PublicLotPhoto } from '../../services/discovery-service'
import { LotPhoto } from './LotPhoto'

/** Foto principal y miniaturas para elegir. Sin fotos, el reemplazo local. */
export function LotGallery({ photos, title }: { photos: PublicLotPhoto[]; title: string }) {
  const [selected, setSelected] = useState(0)
  const current = photos[Math.min(selected, photos.length - 1)]
  return (
    <div className="lot-gallery">
      <LotPhoto src={current?.displayUrl ?? null} description={photos.length > 1 ? `Foto ${selected + 1} de ${photos.length}: ${title}` : `Fotografía del pack: ${title}`} />
      {photos.length > 1 && (
        <ul className="lot-gallery__thumbs" aria-label="Fotos del lote">
          {photos.map((photo, index) => (
            <li key={photo.id}>
              <button type="button" className="lot-gallery__thumb" aria-label={`Ver foto ${index + 1}`} aria-pressed={index === selected} onClick={() => setSelected(index)}>
                <img src={photo.thumbnailUrl} alt="" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
