import type { ComponentPropsWithRef } from 'react'

export function Input({ className = '', ...props }: ComponentPropsWithRef<'input'>) {
  return <input {...props} className={`ui-control ${className}`} />
}

export function Textarea({ className = '', rows = 4, ...props }: ComponentPropsWithRef<'textarea'>) {
  return <textarea {...props} rows={rows} className={`ui-control ui-textarea ${className}`} />
}

export function Select({ className = '', ...props }: ComponentPropsWithRef<'select'>) {
  return <select {...props} className={`ui-control ${className}`} />
}
