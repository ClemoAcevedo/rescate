import type { ComponentPropsWithoutRef } from 'react'

type AlertProps = Omit<ComponentPropsWithoutRef<'div'>, 'role'> & {
  tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral'
  /** Elegir explícitamente si un cambio debe anunciarse. */
  role?: 'status' | 'alert'
}

export function Alert({ tone = 'info', className = '', ...props }: AlertProps) {
  return <div {...props} className={`ui-alert ui-alert--${tone} ${className}`} />
}
