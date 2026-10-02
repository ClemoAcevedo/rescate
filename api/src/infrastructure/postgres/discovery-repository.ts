import type { DiscoveryRepository, PublicLot, PublicPhoto, Reservation } from '../../application/discovery/ports.js'
import { withTransaction } from './pool.js'
import type { Pool, PoolClient } from './pool.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
interface LotRow {
  id: string; description: string; category: string; quantity: number; available_quantity: number
  conditions: string | null; address: string; latitude: number; longitude: number; time_zone: string
  pickup_starts_at: Date; pickup_ends_at: Date; distance_km: number | null; photos: PublicPhoto[]
}
interface ReservationRow { id: string; lot_id: string; quantity: number; created_at: Date }

const location = 'ST_SetSRID(ST_MakePoint(l.longitude, l.latitude), 4326)::geography'
const origin = 'ST_SetSRID(ST_MakePoint($4::float8, $3::float8), 4326)::geography'
const distance = `ST_Distance(${location}, ${origin}) / 1000.0`
const publicColumns = `l.public_id::text AS id, l.description, l.category, l.quantity,
  GREATEST(0, l.quantity - COALESCE((SELECT sum(c.quantity) FROM public.commitments c
    WHERE c.lot_id = l.id AND c.status = 'confirmed'), 0))::integer AS available_quantity,
  l.conditions, l.address, l.latitude, l.longitude, l.time_zone, l.pickup_starts_at,
  l.pickup_ends_at, ${distance} AS distance_km,
  (SELECT COALESCE(json_agg(json_build_object('id', p.public_id::text, 'width', p.width, 'height', p.height)
      ORDER BY p.position), '[]'::json)
    FROM public.lot_photos p WHERE p.lot_id = l.id AND p.status = 'ready') AS photos`

function toLot(row: LotRow): PublicLot {
  return { id: row.id, description: row.description, category: row.category, quantity: row.quantity,
    availableQuantity: row.available_quantity, conditions: row.conditions, address: row.address,
    latitude: row.latitude, longitude: row.longitude, timeZone: row.time_zone,
    pickupStartsAt: row.pickup_starts_at, pickupEndsAt: row.pickup_ends_at,
    photoId: row.photos[0]?.id ?? null, photos: row.photos, distanceKm: row.distance_km === null ? null : Math.round(row.distance_km * 10) / 10 }
}
function toReservation(row: ReservationRow): Reservation {
  return { id: row.id, lotId: row.lot_id, quantity: row.quantity,
    createdAt: row.created_at }
}
// Sin instante no se filtra por ventana: la reserva la comprueba Application con su reloj.
async function readLot(db: Pool | PoolClient, lotId: string, now: Date | null): Promise<PublicLot | null> {
  if (!uuid.test(lotId)) return null
  const { rows } = await db.query<LotRow>(
    `SELECT ${publicColumns} FROM public.lots l
     WHERE l.public_id = $1 AND l.status = 'published'
       AND ($2::timestamptz IS NULL OR l.pickup_ends_at > $2)`,
    [lotId, now, null, null],
  )
  return rows[0] ? toLot(rows[0]) : null
}

export function createDiscoveryRepository(pool: Pool): DiscoveryRepository {
  return {
    async search(filters, now) {
      const { rows } = await pool.query<LotRow>(
        `SELECT ${publicColumns} FROM public.lots l
         WHERE l.status = 'published' AND l.pickup_ends_at > $1
           AND ($2::text IS NULL OR lower(l.category) = lower($2))
           AND ($5::float8 IS NULL OR ST_DWithin(${location}, ${origin}, $5 * 1000.0))
           AND ($6::timestamptz IS NULL OR l.pickup_starts_at <= $6)
         ORDER BY distance_km ASC NULLS LAST, l.published_at DESC, l.id DESC
         LIMIT 13 OFFSET $7`,
        [now, filters.category ?? null, filters.latitude ?? null, filters.longitude ?? null,
          filters.radiusKm ?? null, filters.pickupBefore ?? null, (filters.page - 1) * 12],
      )
      return { items: rows.slice(0, 12).map(toLot), hasNextPage: rows.length > 12 }
    },
    get(lotId, now) {
      return readLot(pool, lotId, now)
    },
    async withReservationTransaction(userId, lotId, key, operate) {
      return withTransaction(pool, async (client) => {
        await client.query("SET LOCAL lock_timeout = '2s'")
        // Una clave reintentada sobre otro lote también se serializa por usuario.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${userId}:${key}`])
        const prior = await client.query<ReservationRow>(
          `SELECT c.public_id::text AS id, l.public_id::text AS lot_id,
                  c.quantity, c.created_at
           FROM public.commitments c JOIN public.lots l ON l.id = c.lot_id
           WHERE c.user_id = $1 AND c.idempotency_key = $2`, [userId, key],
        )
        if (prior.rows[0]) return operate({ lot: null, existing: toReservation(prior.rows[0]), active: false }, {
          insert: async () => { throw new Error('Reintento no debe insertar') },
        })
        let lot: PublicLot | null = null
        let active = false
        if (uuid.test(lotId)) {
          const locked = await client.query<{ id: string }>(
            'SELECT id::text FROM public.lots WHERE public_id = $1 FOR UPDATE', [lotId],
          )
          if (locked.rows[0]) {
            lot = await readLot(client, lotId, null)
            const found = await client.query<{ active: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM public.commitments
               WHERE user_id = $1 AND lot_id = $2 AND status = 'confirmed') AS active`,
              [userId, locked.rows[0].id],
            )
            active = found.rows[0]?.active ?? false
          }
        }
        return operate({ lot, existing: null, active }, {
          insert: async (quantity, at) => {
            const inserted = await client.query<ReservationRow>(
              `INSERT INTO public.commitments (user_id, lot_id, quantity, status, created_at, idempotency_key)
               SELECT $1, id, $3, 'confirmed', $4, $5 FROM public.lots WHERE public_id = $2
               RETURNING public_id::text AS id, $2::text AS lot_id, quantity, created_at`,
              [userId, lotId, quantity, at, key],
            )
            if (!inserted.rows[0]) throw new Error('La reserva no afectó ninguna fila')
            return toReservation(inserted.rows[0])
          },
        })
      })
    },
  }
}
