import type { ComponentPropsWithRef } from 'react'

type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  loading?: boolean
  block?: boolean
}

export function Button({
  variant = 'primary', loading = false, block = false,
  disabled, type = 'button', className = '', children, ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`ui-button ui-button--${variant}${block ? ' ui-button--block' : ''} ${className}`}
    >
      {children}
    </button>
  )
}
