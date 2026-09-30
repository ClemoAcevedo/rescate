import type { ComponentPropsWithoutRef } from 'react'

type BadgeProps = ComponentPropsWithoutRef<'span'> & {
  tone?: 'neutral' | 'success' | 'warning' | 'info' | 'danger'
}

/** Metadato visual; la página decide el texto, sin catálogos de estados de negocio. */
export function Badge({ tone = 'neutral', className = '', ...props }: BadgeProps) {
  return <span {...props} className={`ui-badge ui-badge--${tone} ${className}`} />
}
