import { useState } from 'react'

/** La imagen de reemplazo también cubre URLs caducadas o imágenes que no cargan. */
export function LotPhoto({ src, description }: { src: string | null; description: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const visibleSource = src && src !== failedSource ? src : null

  return visibleSource
    ? <img className="lot-photo" src={visibleSource} alt={description} onError={() => setFailedSource(visibleSource)} />
    : <div className="lot-photo lot-photo--replacement" role="img" aria-label="Fotografía no disponible">
      <svg viewBox="0 0 160 120" aria-hidden="true" focusable="false">
        <rect x="27" y="38" width="106" height="63" rx="8" fill="none" stroke="currentColor" strokeWidth="5" />
        <path d="M51 38v-9a10 10 0 0 1 10-10h38a10 10 0 0 1 10 10v9M47 84l23-23 18 18 15-15 20 20" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="111" cy="51" r="5" fill="currentColor" />
      </svg>
      <span>Fotografía no disponible</span>
    </div>
}
