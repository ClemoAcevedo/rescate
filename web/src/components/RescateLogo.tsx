import { Icon } from './Icon'

type RescateLogoProps = {
  className?: string
}

export function RescateLogo({ className = '' }: RescateLogoProps) {
  return <span className={`rescate-logo ${className}`}><span className="rescate-logo__mark"><Icon name="leaf" /></span>Rescate</span>
}
