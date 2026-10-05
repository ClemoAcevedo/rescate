export interface PublicLot {
  id: string
  description: string
  category: string
  quantity: number
  availableQuantity: number
  conditions: string | null
  address: string
  latitude: number
  longitude: number
  timeZone: string
  pickupStartsAt: Date
  pickupEndsAt: Date
  /** Primera foto lista por posición; HTTP la representa como ruta de imagen. */
  photoId: string | null
  /** Fotos listas en orden de posición. */
  photos: PublicPhoto[]
  distanceKm: number | null
}

export interface PublicPhoto {
  id: string
  width: number
  height: number
}

export interface SearchFilters {
  category?: string
  latitude?: number
  longitude?: number
  radiusKm?: number
  pickupBefore?: Date
  page: number
}

export interface Reservation {
  id: string
  lotId: string
  quantity: number
  createdAt: Date
}

export interface ReservationWriter {
  /** Crea la reserva y mueve la misma cantidad de libres a reservados (F → R). */
  insert(quantity: number, at: Date): Promise<Reservation>
}

/** Resultado previo de la clave, o el lote releído bajo bloqueo con el reloj de la base. */
export type ReservationState =
  | { existing: Reservation }
  | { existing: null; lot: null }
  | { existing: null; lot: PublicLot; active: boolean; reconciled: boolean; now: Date }

export interface DiscoveryRepository {
  search(filters: SearchFilters, now: Date): Promise<{ items: PublicLot[]; hasNextPage: boolean }>
  get(publicId: string, now: Date): Promise<PublicLot | null>
  withReservationTransaction<T>(userId: string, lotId: string, idempotencyKey: string,
    operate: (state: ReservationState, writer: ReservationWriter) => Promise<T>): Promise<T>
}
