/* Generado desde docs/api/openapi.yaml. No editar; npm run api:types. */

/**
 * Correo identificador, sin afirmar verificación. Registro y login recortan espacios exteriores y comparan sin distinguir mayúsculas/minúsculas; se conservan puntos y sufijos +. La respuesta devuelve el correo normalizado en minúsculas. En entrada el formato se comprueba DESPUÉS de normalizar.
 */
export type EmailInput = string
/**
 * Contraseña de entrada; mínimo de 12 caracteres. Nunca se devuelve ni se registra en logs.
 */
export type Password = string
export type PublicId = string
/**
 * Correo normalizado en minúsculas, sin espacios exteriores; no afirma verificación ni elimina puntos o sufijos +.
 */
export type Email = string
/**
 * Token opaco de protección CSRF, no credencial de autenticación. Copiar al header X-CSRF-Token; no URL, logs ni almacenamiento persistente del frontend.
 */
export type CsrfToken = string
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
 * Representación para operador autorizado en S02. No incluye reservas, contadores futuros, claves de objetos ni columnas internas. Sin updatedAt inventado. Las fotos son opcionales y se consultan en GET /lots/{lotId}/photos.
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
  status: LotStatus
  version: Version
  createdAt: Instant
  /**
   * null en draft; instante asignado por servidor al publicar.
   */
  publishedAt: string | null
}
/**
 * expired y withdrawn son cierres lógicos: el lote deja de ofrecerse, pero se conserva con su historial.
 */
export type LotStatus = "draft" | "published" | "expired" | "withdrawn"
/**
 * Estado vigente al responder. confirmed: vigente; cancelled: cancelada por su titular; expired: el lote cerró sin retiro, aunque el trabajador aún no lo haya registrado; delivered: retiro acreditado. Los tres últimos son terminales.
 */
export type ReservationStatus = "confirmed" | "cancelled" | "expired" | "delivered"
/**
 * Código tal como lo dicta la persona; el servidor ignora espacios, guiones y mayúsculas. Nunca en URL ni logs.
 */
export type PickupCode = string

export interface HttpSchemas {
  LoginRequest: LoginRequest
  LoginResponse: LoginResponse
  RegisterRequest: RegisterRequest
  RegisterResponse: RegisterResponse
  SessionResponse: SessionResponse
  CreateLotDraftRequest: CreateLotDraftRequest
  UpdateLotDraftRequest: UpdateLotDraftRequest
  PublishLotDraftRequest: PublishLotDraftRequest
  LotResponse: LotResponse
  PublicLot: PublicLot
  PublicLotPage: PublicLotPage
  PublicLotPhoto: PublicLotPhoto
  OperatorLotSummary: OperatorLotSummary
  OperatorLotPage: OperatorLotPage
  ReserveLotRequest: ReserveLotRequest
  ReservationResponse: ReservationResponse
  ReservationLot: ReservationLot
  ReservationSummary: ReservationSummary
  ReservationDetail: ReservationDetail
  ReservationPage: ReservationPage
  PickupReviewRequest: PickupReviewRequest
  PickupReview: PickupReview
  ConfirmPickupRequest: ConfirmPickupRequest
  PickupResponse: PickupResponse
  LotPhoto: LotPhoto
  LotPhotoList: LotPhotoList
  ErrorResponse: ErrorResponse
  ValidationIssue: ValidationIssue
}
export interface LoginRequest {
  email: EmailInput
  password: Password
}
export interface LoginResponse {
  session: Session
  csrfToken: CsrfToken
}
/**
 * Representación pública de sesión. Su credencial opaca viaja exclusivamente en cookie HttpOnly; no hay JWT ni refresh token.
 */
export interface Session {
  user: User
  /**
   * Lista sin establecimientos duplicados; puede estar vacía. Una persona puede operar varios. Es información para la UI, no autorización reutilizable.
   */
  operableEstablishments: OperableEstablishment[]
  /**
   * Vencimiento absoluto de la sesión: 12 horas desde login; consultar sesión no lo renueva.
   */
  expiresAt: string
}
/**
 * Representación pública mínima; sin credenciales, estado de verificación ni datos persistidos de autenticación.
 */
export interface User {
  id: PublicId
  email: Email
}
/**
 * Establecimiento que esta persona puede operar actualmente. Derivado de habilitación y pertenencia reales; no incluye el ID interno de membership ni un catálogo anticipado de roles.
 */
export interface OperableEstablishment {
  id: PublicId
  name: string
}
/**
 * Crea solo la cuenta; no acepta establishmentId, membresías, roles ni displayName.
 */
export interface RegisterRequest {
  email: EmailInput
  password: Password
  /**
   * Consentimiento para tratar el correo de la cuenta. false responde 422 y no crea la cuenta; true queda registrado con la versión vigente del texto.
   */
  privacyConsent: boolean
}
/**
 * Cuenta creada sin sesión ni membresías operables automáticas.
 */
export interface RegisterResponse {
  user: User
}
export interface SessionResponse {
  /**
   * null para visitante, cookie ausente, sesión inválida o vencida. No crea una sesión autenticada.
   */
  session: Session | null
  csrfToken: CsrfToken
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
export interface PublicLot {
  id: PublicId
  description: LotDescription
  category: Category
  quantity: Quantity
  /**
   * Packs libres al instante de la lectura; puede cambiar.
   */
  availableQuantity: number
  conditions: Conditions
  address: Address
  latitude: Latitude
  longitude: Longitude
  timeZone: TimeZone
  pickupStartsAt: Instant
  pickupEndsAt: Instant
  /**
   * Ruta relativa a la base de la API de la primera foto lista: miniatura en la búsqueda e imagen de presentación en el detalle. null muestra reemplazo local.
   */
  photoUrl: string | null
  /**
   * Fotos listas en orden de posición; vacío muestra reemplazo local. photoUrl corresponde a la primera.
   *
   * @maxItems 3
   */
  photos: PublicLotPhoto[]
  /**
   * Distancia geográfica aproximada al punto enviado.
   */
  distanceKm: number | null
}
/**
 * Foto lista de un lote publicado. Las imágenes se leen sin sesión.
 */
export interface PublicLotPhoto {
  id: PublicId
  /**
   * Ancho de la imagen de presentación.
   */
  width: number
  height: number
  thumbnailUrl: string
  displayUrl: string
}
export interface PublicLotPage {
  /**
   * @maxItems 12
   */
  items: PublicLot[]
  page: number
  hasNextPage: boolean
}
/**
 * Resumen de un lote para el operador de su establecimiento.
 */
export interface OperatorLotSummary {
  id: PublicId
  status: LotStatus
  version: Version
  description: LotDescription
  category: Category
  quantity: Quantity
  /**
   * Packs en reservas confirmadas; 0 en borradores.
   */
  reservedQuantity: number
  pickupStartsAt: Instant
  pickupEndsAt: Instant
  timeZone: TimeZone
  createdAt: Instant
  publishedAt: string | null
  /**
   * Miniatura de la primera foto lista.
   */
  photoUrl: string | null
}
export interface OperatorLotPage {
  /**
   * @maxItems 20
   */
  items: OperatorLotSummary[]
  page: number
  hasNextPage: boolean
}
export interface ReserveLotRequest {
  quantity: number
  /**
   * UUID generado por el cliente para una intención de reserva.
   */
  idempotencyKey: string
}
export interface ReservationResponse {
  id: PublicId
  lotId: PublicId
  quantity: number
  /**
   * Resultado de la creación. Un reintento con la misma clave lo reproduce aunque la reserva haya terminado; el estado vigente y el código se consultan en GET /reservations/{reservationId}.
   */
  status: "confirmed"
  createdAt: Instant
}
/**
 * Lote de la reserva para su titular: contenido, lugar y plazo publicados.
 */
export interface ReservationLot {
  id: PublicId
  description: LotDescription
  conditions: Conditions
  address: Address
  latitude: Latitude
  longitude: Longitude
  timeZone: TimeZone
  pickupStartsAt: Instant
  pickupEndsAt: Instant
}
export interface ReservationSummary {
  id: PublicId
  quantity: number
  status: ReservationStatus
  createdAt: Instant
  /**
   * Instante en que terminó; null mientras está confirmada. Una reserva vencida terminó al cierre del lote.
   */
  endedAt: string | null
  lot: ReservationLot
}
export interface ReservationDetail {
  id: PublicId
  quantity: number
  status: ReservationStatus
  createdAt: Instant
  /**
   * Instante en que terminó; null mientras está confirmada.
   */
  endedAt: string | null
  lot: ReservationLot
  /**
   * Código de retiro: credencial de ocho caracteres para mostrar al operador. Solo mientras status es confirmed; si no, null. No guardarlo en URL, historial, logs ni almacenamiento persistente del navegador.
   */
  pickupCode: string | null
}
export interface ReservationPage {
  /**
   * @maxItems 20
   */
  items: ReservationSummary[]
  page: number
  hasNextPage: boolean
}
export interface PickupReviewRequest {
  code: PickupCode
}
export interface PickupReview {
  reservation: ReviewedReservation
  /**
   * true si la reserva está confirmada y la ventana ya comenzó. Es orientativo: confirmar vuelve a validar todo bajo bloqueo. false con status confirmed significa que la ventana aún no comienza.
   */
  canConfirm: boolean
}
/**
 * Reserva vista por el operador: sin datos del titular ni el código.
 */
export interface ReviewedReservation {
  id: PublicId
  quantity: number
  status: ReservationStatus
  createdAt: Instant
  endedAt: string | null
}
export interface ConfirmPickupRequest {
  /**
   * Reserva mostrada por la revisión.
   */
  reservationId: string
  code: PickupCode
  /**
   * UUID generado por el cliente para esta confirmación; único por operador.
   */
  idempotencyKey: string
}
export interface PickupResponse {
  reservationId: PublicId
  /**
   * Packs entregados: la reserva completa.
   */
  quantity: number
  deliveredAt: Instant
}
/**
 * Foto de un lote para su operador. Sin claves de objeto, tamaño original ni autor interno.
 */
export interface LotPhoto {
  id: PublicId
  position: number
  /**
   * uploading: carga en curso; pending: en validación; ready: visible; rejected: debe quitarse antes de publicar.
   */
  status: "uploading" | "pending" | "ready" | "rejected"
  createdAt: Instant
  /**
   * Ancho de la imagen de presentación; solo en ready.
   */
  width: number | null
  height: number | null
  /**
   * Solo en rejected.
   */
  rejectionReason:
    | "unsupported_format"
    | "animated"
    | "too_many_pixels"
    | "undecodable"
    | "output_too_large"
    | "processing_failed"
    | null
  /**
   * Ruta relativa a la base de la API; solo en ready.
   */
  thumbnailUrl: string | null
  displayUrl: string | null
}
/**
 * Identificador público opaco. No es la PK bigint ni su conversión a string; no se presupone UUID, prefijo ni formato concreto. Los ejemplos no fijan representación. No sustituye autorización.
 */
export interface LotPhotoList {
  /**
   * @maxItems 3
   */
  items: LotPhoto[]
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
