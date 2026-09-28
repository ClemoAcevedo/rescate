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
  photoUrl: string | null
  distanceKm: number | null
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
  userId: string
  quantity: number
  createdAt: Date
  idempotencyKey: string | null
}

export interface ReservationWriter {
  insert(quantity: number, at: Date): Promise<Reservation>
}

export interface DiscoveryRepository {
  search(filters: SearchFilters, now: Date): Promise<{ items: PublicLot[]; hasNextPage: boolean }>
  get(publicId: string, now: Date): Promise<PublicLot | null>
  withReservationTransaction<T>(userId: string, lotId: string, idempotencyKey: string,
    operate: (state: { lot: PublicLot | null; existing: Reservation | null; active: boolean }, writer: ReservationWriter) => Promise<T>): Promise<T>
}
