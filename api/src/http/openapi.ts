/* Generado desde docs/api/openapi.yaml. No editar; npm run api:types. */

/**
 * Contenido del pack indivisible; no hay título adicional. No puede ser solo espacios.
 */
export type LotDescription = string
/**
 * Texto no vacío, representación provisional heredada de K003. No hay catálogo acordado: BLOCKING DECISION solo para fijar un enum/catálogo futuro; no inventar categorías obligatorias.
 */
export type Category = string
/**
 * Cantidad declarada de packs indivisibles, no stock disponible. Sin máximo funcional de 2 ni de 100 packs.
 */
export type Quantity = number
/**
 * Condiciones particulares para el retiro, por ejemplo traer una bolsa. null significa que no se indican condiciones particulares. Decisión explícita de S02; no sustituye contenido, dirección ni ventana.
 */
export type Conditions = string | null
/**
 * Dirección del retiro, no solo espacios. Instantánea del lote.
 */
export type Address = string
/**
 * Latitud WGS84 en grados.
 */
export type Latitude = number
/**
 * Longitud WGS84 en grados.
 */
export type Longitude = number
/**
 * Identificador IANA válido, por ejemplo America/Santiago. Se valida en aplicación; no se sustituye por un offset fijo.
 */
export type TimeZone = string
/**
 * Instante RFC 3339 con Z u offset explícito; respuestas en UTC (Z). No aceptar hora local sin offset.
 */
export type Instant = string
/**
 * Versión optimista administrada por servidor. Nace en 1 y aumenta en 1 con cada PATCH aceptado y publicación. En comandos significa versión esperada.
 */
export type Version = number
/**
 * Representación para operador autorizado en S02. No incluye reservas, contadores futuros, claves de objetos, fotos sin validar ni columnas internas. Sin updatedAt inventado. Las fotos son opcionales y su transporte se acordará con K014.
 */
export type LotResponse = {
  id: PublicId
  establishmentId: PublicId
  description: LotDescription
  category: Category
  quantity: Quantity
  conditions: Conditions
  address: Address
  latitude: Latitude
  longitude: Longitude
  timeZone: TimeZone
  pickupStartsAt: Instant
  pickupEndsAt: Instant
  status: "draft" | "published"
  version: Version
  createdAt: Instant
  /**
   * null en draft; instante asignado por servidor al publicar.
   */
  publishedAt: string | null
}
/**
 * Identificador público opaco. No es la PK bigint ni su conversión a string; no se presupone UUID, prefijo ni formato concreto. Los ejemplos no fijan representación. No sustituye autorización.
 */
export type PublicId = string

export interface HttpSchemas {
  CreateLotDraftRequest: CreateLotDraftRequest
  UpdateLotDraftRequest: UpdateLotDraftRequest
  PublishLotDraftRequest: PublishLotDraftRequest
  LotResponse: LotResponse
  ErrorResponse: ErrorResponse
  ValidationIssue: ValidationIssue
}
/**
 * Borrador completo en sus campos mínimos. conditions omitido equivale a null. El servidor asigna establecimiento desde la ruta y comprueba permiso. No admite id, propietario, status, version ni timestamps del servidor. Ventana: fin posterior a inicio. Fotos opcionales fuera de este contrato de escritura.
 */
export interface CreateLotDraftRequest {
  description: LotDescription
  category: Category
  quantity: Quantity
  conditions?: Conditions
  address: Address
  latitude: Latitude
  longitude: Longitude
  timeZone: TimeZone
  pickupStartsAt: Instant
  pickupEndsAt: Instant
}
/**
 * PATCH parcial sobre un borrador completo: versión esperada y al menos un campo editable. Omitido conserva el valor; solo conditions admite null para borrar la indicación. Revalidar el conjunto resultante, incluida la ventana. No permite reasignar establecimiento ni modificar un publicado.
 */
export interface UpdateLotDraftRequest {
  version: Version
  description?: LotDescription
  category?: Category
  quantity?: Quantity
  conditions?: Conditions
  address?: Address
  latitude?: Latitude
  longitude?: Longitude
  timeZone?: TimeZone
  pickupStartsAt?: Instant
  pickupEndsAt?: Instant
}
/**
 * Solo versión esperada del borrador que el operador revisó. No admite contenido nuevo, estado ni publishedAt.
 */
export interface PublishLotDraftRequest {
  version: Version
}
export interface ErrorResponse {
  error: {
    /**
     * Código estable para frontend, asociado al estado HTTP documentado.
     */
    code:
      | "MALFORMED_REQUEST"
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "PAYLOAD_TOO_LARGE"
      | "UNSUPPORTED_MEDIA_TYPE"
      | "VALIDATION_ERROR"
      | "RATE_LIMITED"
      | "INTERNAL_ERROR"
      | "SERVICE_UNAVAILABLE"
    /**
     * Mensaje humano seguro; no usarlo como identificador de error.
     */
    message: string
    details?: ErrorDetails
  }
}
/**
 * Detalle opcional para validación. Nunca incluye entradas sensibles, secretos ni diagnósticos internos.
 */
export interface ErrorDetails {
  /**
   * @minItems 1
   */
  issues: [ValidationIssue, ...ValidationIssue[]]
}
export interface ValidationIssue {
  /**
   * JSON Pointer al campo de entrada; no contiene su valor.
   */
  path: string
  /**
   * Descripción segura del problema.
   */
  message: string
}
