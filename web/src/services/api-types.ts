export interface Identity {
  id: string
  email: string
  displayName?: string
}

export interface RegistrationInput {
  email: string
  password: string
  displayName?: string
}

export interface LoginInput {
  email: string
  password: string
}

export interface Session {
  user: Identity
}

/**
 * Los valores de estado siguen abiertos hasta que backend defina un catálogo.
 */
export type LotStatus = string

export interface LotSummary {
  id: string
  title: string
  description?: string
  quantity?: string
  pickupLocation?: string
  expiresAt?: string
  status?: LotStatus
}

export interface Lot extends LotSummary {
  publishedAt?: string
}

export interface LotListResponse {
  items: LotSummary[]
  nextCursor?: string | null
  total?: number
}
