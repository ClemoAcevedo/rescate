import type { LotResponse } from '../services/lots-service'

type BadgeTone = 'neutral' | 'success' | 'info'

/** Vencido y retirado son cierres lógicos: el lote se conserva para el operador, pero ya no se ofrece. */
export const lotStatusBadges: Record<LotResponse['status'], { label: string; tone: BadgeTone }> = {
  draft: { label: 'Borrador', tone: 'info' },
  published: { label: 'Publicado', tone: 'success' },
  expired: { label: 'Vencido', tone: 'neutral' },
  withdrawn: { label: 'Retirado', tone: 'neutral' },
}
