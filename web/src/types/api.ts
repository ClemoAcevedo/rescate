/**
 * Antecedente HTTP K004; no tipos de dominio vigentes ni tipos generados.
 * Fuente HTTP: docs/api/openapi.yaml. Sustituir al integrar K009/K011;
 * no mantener este catálogo manual en paralelo con OpenAPI.
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
