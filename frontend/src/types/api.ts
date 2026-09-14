/**
 * Tipos de dominio propuestos y pendientes de validación con backend.
 * Los valores posibles de `status` y los campos opcionales deberán confirmarse
 * antes de consumir respuestas reales.
 */
export interface Identity {
  id: string
  email: string
  displayName?: string
}

export interface RegisterInput {
  email: string
  password: string
  displayName?: string
}

export interface LoginInput {
  email: string
  password: string
}

export interface LotSummary {
  id: string
  title: string
  status: string
  quantityDescription?: string
  publishedAt?: string
}

export interface LotDetail extends LotSummary {
  description?: string
  expiresAt?: string
  pickupLocation?: string
}
