import type { HTMLAttributes } from 'react'

type CardProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'article'
  tone?: 'default' | 'sunken'
}

export function Card({ as: Tag = 'div', tone = 'default', className = '', ...props }: CardProps) {
  return <Tag {...props} className={`ui-card ui-card--${tone} ${className}`} />
}
