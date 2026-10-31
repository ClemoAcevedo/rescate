/* Generado desde docs/api/openapi.yaml. No editar; npm run api:types. */

/**
 * expired y withdrawn son cierres lógicos: el lote deja de ofrecerse, pero se conserva con su historial.
 */
export type LotStatus = "draft" | "published" | "expired" | "withdrawn"
export type PublicId = string
/**
 * Instante RFC 3339 con Z u offset explícito; respuestas en UTC (Z). No aceptar hora local sin offset.
 */
export type Instant = string
/**
 * Correo identificador, sin afirmar verificación. Registro y login recortan espacios exteriores y comparan sin distinguir mayúsculas/minúsculas; se conservan puntos y sufijos +. La respuesta devuelve el correo normalizado en minúsculas. En entrada el formato se comprueba DESPUÉS de normalizar.
 */
export type EmailInput = string
/**
 * Contraseña de entrada; mínimo de 12 caracteres. Nunca se devuelve ni se registra en logs.
 */
export type Password = string
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
 * Versión optimista administrada por servidor. Nace en 1 y aumenta en 1 con cada PATCH aceptado y publicación. En comandos significa versión esperada.
 */
export type Version = number
/**
 * Representación para operador autorizado en S02. No incluye reservas, contadores futuros, claves de objetos ni columnas internas. Sin updatedAt inventado. Las fotos son opcionales y se consultan en GET /lots/{lotId}/photos.
 */
export type LotResponse = {
  /**
   * Suspensión reversible de nuevas asignaciones.
   */
  paused?: boolean
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
 * Estado vigente al responder. confirmed: vigente; cancelled: cancelada por su titular; expired: el lote cerró sin retiro, aunque el trabajador aún no lo haya registrado; delivered: retiro acreditado. Los tres últimos son terminales.
 */
export type ReservationStatus = "confirmed" | "cancelled" | "expired" | "delivered"
/**
 * Estado vigente al responder. waiting: en la cola sin packs retenidos; offered: tiene una oferta vigente que retiene packs; accepted, declined, expired y left son terminales. Una oferta no aceptada a tiempo y una espera de un lote cerrado se informan expired aunque el trabajador aún no lo haya registrado.
 */
export type WaitlistStatus = "waiting" | "offered" | "accepted" | "declined" | "expired" | "left"
/**
 * Código tal como lo dicta la persona; el servidor ignora espacios, guiones y mayúsculas. Nunca en URL ni logs.
 */
export type PickupCode = string
/**
 * offer_issued: oferta por aceptar; offer_expired: la oferta venció sin aceptarse; reservation_confirmed: la oferta aceptada creó la reserva; reservation_cancelled: el titular canceló su reserva. message_from_holder llega a los operadores del local y message_from_establishment al titular cuando la otra parte escribe en el chat de la reserva. No traen el texto, que se lee en la conversación.
 */
export type NotificationKind =
  | "offer_issued"
  | "offer_expired"
  | "reservation_confirmed"
  | "reservation_cancelled"
  | "message_from_holder"
  | "message_from_establishment"
/**
 * Fecha calendario en la zona del establecimiento, sin hora.
 */
export type LocalDate = string
/**
 * Reserva: ReservationStatus. Solicitud de espera: WaitlistStatus. Vigente al responder.
 */
export type CommitmentStatus =
  "confirmed" | "cancelled" | "expired" | "delivered" | "waiting" | "offered" | "accepted" | "declined" | "left"
/**
 * reservation_confirmed: reserva directa; offer_accepted: la oferta aceptada creó la reserva; pickup_confirmed: retiro acreditado; waitlist_expired: la espera terminó con el cierre del lote.
 */
export type ActivityKind =
  | "lot_published"
  | "lot_expired"
  | "lot_withdrawn"
  | "reservation_confirmed"
  | "reservation_cancelled"
  | "reservation_expired"
  | "pickup_confirmed"
  | "waitlist_joined"
  | "offer_issued"
  | "offer_accepted"
  | "offer_declined"
  | "offer_expired"
  | "waitlist_left"
  | "waitlist_expired"

export interface HttpSchemas {
  LotManagementRequest: LotManagementRequest
  LotManagementResponse: LotManagementResponse
  LotOperation: LotOperation
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
  JoinWaitlistRequest: JoinWaitlistRequest
  WaitlistEntry: WaitlistEntry
  WaitlistPage: WaitlistPage
  PickupReviewRequest: PickupReviewRequest
  PickupReview: PickupReview
  ConfirmPickupRequest: ConfirmPickupRequest
  PickupResponse: PickupResponse
  LotPhoto: LotPhoto
  LotPhotoList: LotPhotoList
  ErrorResponse: ErrorResponse
  ValidationIssue: ValidationIssue
  Notification: Notification
  NotificationPage: NotificationPage
  HealthStatus: HealthStatus
  EstablishmentPanel: EstablishmentPanel
  PanelInventory: PanelInventory
  PanelOpenLot: PanelOpenLot
  OperatorCommitment: OperatorCommitment
  OperatorCommitmentPage: OperatorCommitmentPage
  ActivityEvent: ActivityEvent
  ActivityPage: ActivityPage
  SendMessageRequest: SendMessageRequest
  SentMessage: SentMessage
  ChatMessage: ChatMessage
  ChatMessagePage: ChatMessagePage
}
export interface LotManagementRequest {
  action: "reduce_stock" | "pause" | "resume" | "withdraw"
  version: number
  idempotencyKey: string
  reason: string
  /**
   * Obligatoria solo para reduce_stock; se prohíbe en las demás acciones.
   */
  quantity?: number
}
export interface LotManagementResponse {
  status: LotStatus
  version: number
  paused: boolean
  freeQuantity: number
  offeredQuantity: number
  reservedQuantity: number
  deliveredQuantity: number
  unassignableQuantity: number
  /**
   * @maxItems 20
   */
  history: LotOperation[]
}
export interface LotOperation {
  id: PublicId
  action: "reduce_stock" | "pause" | "resume" | "withdraw"
  quantity: number | null
  reason: string
  createdAt: Instant
  version: number
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
   * @maxItems 50
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
  /**
   * Suspensión reversible de nuevas asignaciones.
   */
  paused?: boolean
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
export interface JoinWaitlistRequest {
  /**
   * Packs que se desean. La oferta puede ser menor (ADR 0002); nunca mayor.
   */
  quantity: number
  /**
   * UUID generado por el cliente para una intención de ingreso.
   */
  idempotencyKey: string
}
export interface WaitlistEntry {
  id: PublicId
  requestedQuantity: number
  status: WaitlistStatus
  /**
   * Packs ofrecidos, nunca más que los solicitados; null si nunca recibió una oferta. Se conserva tras rechazar, vencer o aceptar.
   */
  offeredQuantity: number | null
  /**
   * Fin de la vigencia de la oferta: diez minutos o el cierre del lote, lo que ocurra primero.
   */
  offerExpiresAt: string | null
  /**
   * Lugar en la cola (1 es el primero) mientras status es waiting; si no, null.
   */
  position: number | null
  /**
   * Reserva creada al aceptar, por la cantidad ofrecida; null en cualquier otro estado.
   */
  reservationId: PublicId | null
  createdAt: Instant
  /**
   * Instante en que terminó; null mientras espera o tiene una oferta vigente. Una oferta vencida terminó al llegar su hora y una espera al cierre del lote.
   */
  endedAt: string | null
  lot: ReservationLot
}
export interface WaitlistPage {
  /**
   * @maxItems 20
   */
  items: WaitlistEntry[]
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
   * Cupo de fotos configurado para este servicio.
   */
  limit?: number
  /**
   * @maxItems 50
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
/**
 * Aviso del titular con los datos de la transición. Sin código de retiro ni datos de otras personas.
 */
export interface Notification {
  id: PublicId
  kind: NotificationKind
  createdAt: Instant
  /**
   * null hasta su primera lectura.
   */
  readAt: string | null
  lot: {
    id: PublicId
    description: string
  }
  /**
   * Packs ofrecidos, confirmados o cancelados según el tipo.
   */
  quantity: number
  /**
   * Solicitud de espera relacionada; null en una cancelación.
   */
  waitlistEntryId: string | null
  /**
   * Reserva relacionada; null en avisos de oferta. En los avisos de mensaje es la reserva de la conversación.
   */
  reservationId: string | null
  /**
   * Plazo informado al emitir la oferta; solo en offer_issued. Aceptar vuelve a comprobarlo.
   */
  offerExpiresAt: string | null
}
export interface NotificationPage {
  /**
   * @maxItems 20
   */
  items: Notification[]
  page: number
  hasNextPage: boolean
  /**
   * Avisos propios sin leer, en todas las páginas.
   */
  unreadCount: number
}
export interface HealthStatus {
  status: "ok" | "unavailable"
  database: "ok" | "unavailable"
  worker: "ok" | "stopped" | "unknown"
}
export interface EstablishmentPanel {
  establishment: {
    id: PublicId
    name: string
    timeZone: TimeZone
  }
  asOf: Instant
  /**
   * Estado vigente al consultar. Cada total es la suma de lots.
   */
  current: {
    /**
     * Todos los lotes abiertos, por cierre más próximo.
     */
    lots: PanelOpenLot[]
    inventory: PanelInventory
    confirmedReservations: number
    activeOffers: number
    waitingRequests: number
  }
  /**
   * RF12: lotes cerrados dentro del período. Retirado es entrega acreditada, no consumo; no se convierte en kilos ni ahorro.
   */
  period: {
    from: LocalDate
    to: LocalDate
    closedLots: number
    /**
     * En un lote cerrado published = delivered + unassignable.
     */
    packs: {
      published: number
      delivered: number
      unassignable: number
    }
    /**
     * confirmed cuenta todas las reservas que llegaron a confirmarse; las otras tres son su término y suman confirmed. Ofertas no aceptadas y la espera no son reservas.
     */
    reservations: {
      confirmed: number
      cancelled: number
      expired: number
      delivered: number
    }
    /**
     * Packs retirados sobre packs publicados.
     */
    deliveryRate: PanelRate
    /**
     * Reservas vencidas sobre reservas que llegaron a confirmarse.
     */
    reservationExpiryRate: PanelRate
    /**
     * Lotes del establecimiento que no entran en los indicadores: publicados aún abiertos y borradores.
     */
    excluded: {
      openLots: number
      draftLots: number
    }
  }
}
/**
 * Lote publicado con la ventana de retiro abierta.
 */
export interface PanelOpenLot {
  id: PublicId
  description: LotDescription
  quantity: Quantity
  pickupStartsAt: Instant
  pickupEndsAt: Instant
  inventory: PanelInventory
  /**
   * Reservas vigentes por retirar.
   */
  confirmedReservations: number
  /**
   * Ofertas vigentes por aceptar.
   */
  activeOffers: number
  /**
   * Personas en la cola sin oferta; no poseen packs.
   */
  waitingRequests: number
}
/**
 * Packs por estado (anexos B p. 4): Q = F + O + R + E + X. Una oferta vencida sin registrar ya cuenta como libre.
 */
export interface PanelInventory {
  free: number
  offered: number
  reserved: number
  /**
   * Retiros acreditados por el operador.
   */
  delivered: number
  /**
   * Liberados con el lote ya cerrado; no vuelven a asignarse.
   */
  unassignable: number
}
export interface PanelRate {
  numerator: number
  denominator: number
  /**
   * numerator / denominator; null sin denominador.
   */
  value: number | null
}
/**
 * Reserva o solicitud de espera vista por el operador: sin titular ni código.
 */
export interface OperatorCommitment {
  id: PublicId
  kind: "reservation" | "waitlist"
  status: CommitmentStatus
  lot: PanelLotRef
  /**
   * Packs reservados o, en la espera, solicitados.
   */
  quantity: number
  /**
   * Packs ofrecidos a la solicitud; null en reservas y sin oferta.
   */
  offeredQuantity: number | null
  offerExpiresAt: string | null
  createdAt: Instant
  endedAt: string | null
}
export interface PanelLotRef {
  id: PublicId
  description: LotDescription
}
export interface OperatorCommitmentPage {
  /**
   * @maxItems 20
   */
  items: OperatorCommitment[]
  page: number
  hasNextPage: boolean
}
export interface ActivityEvent {
  /**
   * Identificador opaco del hecho, estable entre consultas.
   */
  id: string
  kind: ActivityKind
  at: Instant
  lot: PanelLotRef
  /**
   * Packs del hecho; null en el cierre del lote.
   */
  quantity: number | null
}
export interface ActivityPage {
  /**
   * @maxItems 20
   */
  items: ActivityEvent[]
  page: number
  hasNextPage: boolean
}
export interface SendMessageRequest {
  /**
   * Texto plano de 1 a 1000 caracteres, contados después de recortar los espacios de los bordes.
   */
  text: string
  /**
   * UUID generado por el cliente para una intención de envío.
   */
  idempotencyKey: string
}
/**
 * Resultado del envío. No repite el texto porque el cliente ya lo tiene.
 */
export interface SentMessage {
  id: PublicId
  /**
   * Posición del mensaje en la conversación.
   */
  sequence: number
  createdAt: Instant
}
/**
 * Mensaje del chat. Dice si lo escribió el titular o el establecimiento sin revelar qué operador fue.
 */
export interface ChatMessage {
  id: PublicId
  sequence: number
  author: "holder" | "operator"
  /**
   * true si lo escribió quien consulta.
   */
  mine: boolean
  text: string
  createdAt: Instant
}
export interface ChatMessagePage {
  /**
   * @maxItems 50
   */
  items: ChatMessage[]
  /**
   * true si hay más mensajes después del último de items.
   */
  hasMore: boolean
  /**
   * true mientras se puede escribir. Cancelar, vencer o retirar la reserva o cerrar el lote lo dejan en false para siempre.
   */
  open: boolean
}
