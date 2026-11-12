import type { CSSProperties, ReactNode } from 'react'

/** Decorativo y sin controles: la página aporta la estructura y las dimensiones reales. */
export function Skeleton({ className = '', width, children = '\u00a0' }: { className?: string; width?: CSSProperties['width']; children?: ReactNode }) {
  return <span aria-hidden="true" className={`ui-skeleton ${className}`} style={width === undefined ? undefined : { width }}>{children}</span>
}

/** Un único anuncio accesible; las formas no se anuncian ni reciben foco. */
export function LoadingState({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return <>
    <span className="visually-hidden" role="status">{label}</span>
    <div className={`loading-state ${className}`} aria-busy="true">
      <div aria-hidden="true" className="loading-state__shapes">{children}</div>
    </div>
  </>
}
