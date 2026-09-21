// K010 · Infrastructure: repositorio PostgreSQL de lotes. SQL parametrizado y
// mapeo de filas a tipos de Domain. No decide autorización ni transiciones.

import type { Lot, LotStatus } from "../../domain/lots.js"
import type {
  LotPublication,
  LotRepository,
  LotUpdate,
  LotWriter,
  NewLot,
} from "../../application/lots/ports.js"
import { withTransaction } from "./pool.js"
import type { Pool, PoolClient } from "./pool.js"

/** Claves internas bigint: se transportan como texto, nunca como Number. */
interface LotRow {
  public_id: string
  establishment_id: string
  establishment_public_id: string
  description: string
  category: string
  quantity: number
  conditions: string | null
  address: string
  latitude: number
  longitude: number
  time_zone: string
  pickup_starts_at: Date
  pickup_ends_at: Date
  status: string
  version: number
  created_at: Date
  updated_at: Date
  published_at: Date | null
}

const LOT_COLUMNS = `public_id::text, establishment_id::text,
  (SELECT public_id::text FROM public.establishments WHERE id = lots.establishment_id) AS establishment_public_id, description, category, quantity,
  conditions, address, latitude, longitude, time_zone, pickup_starts_at, pickup_ends_at,
  status, version, created_at, updated_at, published_at`

function toLot(row: LotRow): Lot {
  return {
    publicId: row.public_id,
    establishmentId: row.establishment_id,
    establishmentPublicId: row.establishment_public_id,
    status: row.status as LotStatus,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    declaration: {
      description: row.description,
      category: row.category,
      quantity: row.quantity,
      conditions: row.conditions,
      address: row.address,
      latitude: row.latitude,
      longitude: row.longitude,
      timeZone: row.time_zone,
      pickupStartsAt: row.pickup_starts_at,
      pickupEndsAt: row.pickup_ends_at,
    },
  }
}

type Queryable = Pick<PoolClient, "query">

/** El identificador público es uuid: un texto con otra forma no es un lote. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function membershipExists(db: Queryable, userId: string, establishmentId: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM public.memberships WHERE user_id = $1 AND establishment_id = $2",
    [userId, establishmentId],
  )
  return rows.length > 0
}

async function findLot(db: Queryable, publicId: string, forUpdate: boolean): Promise<Lot | null> {
  if (!UUID_PATTERN.test(publicId)) return null
  const { rows } = await db.query<LotRow>(
    `SELECT ${LOT_COLUMNS} FROM public.lots WHERE public_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [publicId],
  )
  return rows.length === 0 ? null : toLot(rows[0]!)
}

export function createLotRepository(pool: Pool): LotRepository {
  return {
    async findEstablishment(publicId) {
      if (!UUID_PATTERN.test(publicId)) return null
      const { rows } = await pool.query<{ id: string; publicId: string }>(
        'SELECT id::text, public_id::text AS "publicId" FROM public.establishments WHERE public_id = $1', [publicId],
      )
      return rows[0] ?? null
    },
    async isMemberOfEstablishment(userId, establishmentId) {
      return membershipExists(pool, userId, establishmentId)
    },

    async insertLot(lot: NewLot) {
      const d = lot.declaration
      const { rows } = await pool.query<LotRow>(
        `INSERT INTO public.lots (establishment_id, description, category, quantity, conditions,
           address, latitude, longitude, time_zone, pickup_starts_at, pickup_ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${LOT_COLUMNS}`,
        [
          lot.establishmentId, d.description, d.category, d.quantity, d.conditions,
          d.address, d.latitude, d.longitude, d.timeZone, d.pickupStartsAt, d.pickupEndsAt,
        ],
      )
      return toLot(rows[0]!)
    },

    async findByPublicId(publicId) {
      return findLot(pool, publicId, false)
    },

    async withLotTransaction(publicId, operate) {
      return withTransaction(pool, async (client) => {
        // Bloquea la fila antes de releer estado y versión: la decisión usa el
        // valor vigente, no uno leído antes de esperar por el bloqueo.
        const lot = await findLot(client, publicId, true)
        return operate(lot, createLotWriter(client))
      })
    },
  }
}

function createLotWriter(client: PoolClient): LotWriter {
  return {
    async isMemberOfEstablishment(userId, establishmentId) {
      return membershipExists(client, userId, establishmentId)
    },

    async updateDeclaration(update: LotUpdate) {
      const d = update.declaration
      const { rows } = await client.query<LotRow>(
        `UPDATE public.lots SET description = $3, category = $4, quantity = $5, conditions = $6,
           address = $7, latitude = $8, longitude = $9, time_zone = $10,
           pickup_starts_at = $11, pickup_ends_at = $12,
           version = version + 1, updated_at = $13
         WHERE public_id = $1 AND version = $2 AND status = 'draft'
         RETURNING ${LOT_COLUMNS}`,
        [
          update.publicId, update.expectedVersion, d.description, d.category, d.quantity, d.conditions,
          d.address, d.latitude, d.longitude, d.timeZone, d.pickupStartsAt, d.pickupEndsAt, update.updatedAt,
        ],
      )
      // La fila está bloqueada y ya se comprobaron versión y estado en el caso
      // de uso: una ausencia aquí sería una incoherencia, no un caso esperado.
      if (rows.length === 0) throw new Error("La actualización del borrador no afectó ninguna fila")
      return toLot(rows[0]!)
    },

    async markPublished(publication: LotPublication) {
      const { rows } = await client.query<LotRow>(
        `UPDATE public.lots
         SET status = 'published', published_at = $3, version = version + 1, updated_at = $3
         WHERE public_id = $1 AND version = $2 AND status = 'draft'
         RETURNING ${LOT_COLUMNS}`,
        [publication.publicId, publication.expectedVersion, publication.publishedAt],
      )
      if (rows.length === 0) throw new Error("La publicación no afectó ninguna fila")
      return toLot(rows[0]!)
    },
  }
}
