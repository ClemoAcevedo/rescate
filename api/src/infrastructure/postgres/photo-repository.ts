// K014 · Infrastructure: repositorio PostgreSQL de fotos. SQL parametrizado y
// mapeo a tipos de Application; no decide autorización ni qué foto es válida.

import type { LotStatus } from "../../domain/lots.js"
import type { ImageFormat, PhotoRejection, PhotoStatus } from "../../domain/photos.js"
import type { CleanupItem, LotPhoto, PhotoLot, PhotoRepository, PhotoWriter } from "../../application/photos/ports.js"
import { withTransaction } from "./pool.js"
import type { Pool, PoolClient } from "./pool.js"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface PhotoRow {
  public_id: string
  position: number
  status: PhotoStatus
  uploaded_by: string
  created_at: Date
  upload_expires_at: Date
  format: ImageFormat | null
  width: number | null
  height: number | null
  rejection_reason: PhotoRejection | null
}
interface LotRow { id: string; public_id: string; establishment_id: string; status: LotStatus }

const PHOTO_COLUMNS = `p.public_id::text, p.position, p.status, p.uploaded_by::text, p.created_at,
  p.upload_expires_at, p.format, p.width, p.height, p.rejection_reason`

function toPhoto(row: PhotoRow): LotPhoto {
  return {
    publicId: row.public_id, position: row.position, status: row.status, uploadedBy: row.uploaded_by,
    createdAt: row.created_at, uploadExpiresAt: row.upload_expires_at, format: row.format,
    width: row.width, height: row.height, rejectionReason: row.rejection_reason,
  }
}
const toLot = (row: LotRow): PhotoLot => ({ publicId: row.public_id, establishmentId: row.establishment_id, status: row.status })

type Queryable = Pick<PoolClient, "query">

async function membershipExists(db: Queryable, userId: string, establishmentId: string): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 FROM public.memberships WHERE user_id = $1 AND establishment_id = $2",
    [userId, establishmentId])
  return rows.length > 0
}

async function findLot(db: Queryable, publicId: string, forUpdate: boolean): Promise<LotRow | null> {
  if (!UUID_PATTERN.test(publicId)) return null
  const { rows } = await db.query<LotRow>(
    `SELECT id::text, public_id::text, establishment_id::text, status FROM public.lots
     WHERE public_id = $1${forUpdate ? " FOR UPDATE" : ""}`, [publicId])
  return rows[0] ?? null
}

function createWriter(client: PoolClient, lot: LotRow): PhotoWriter {
  return {
    isMemberOfEstablishment: (userId, establishmentId) => membershipExists(client, userId, establishmentId),

    async listActivePhotos(now) {
      // Liberar posiciones de cargas vencidas no requiere objetos: la limpieza los borra.
      await client.query(
        `UPDATE public.lot_photos SET status = 'removed', removed_at = $2
         WHERE lot_id = $1 AND status = 'uploading' AND upload_expires_at <= $2`, [lot.id, now])
      const { rows } = await client.query<PhotoRow>(
        `SELECT ${PHOTO_COLUMNS} FROM public.lot_photos p
         WHERE p.lot_id = $1 AND p.status <> 'removed' ORDER BY p.position`, [lot.id])
      return rows.map(toPhoto)
    },

    async activeUploadsOf(userId, now) {
      // Dos cargas del mismo operador en lotes distintos no se cuentan a la vez.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`lot-photo-uploads:${userId}`])
      const { rows } = await client.query<{ upload_expires_at: Date }>(
        `SELECT upload_expires_at FROM public.lot_photos
         WHERE uploaded_by = $1 AND status = 'uploading' AND upload_expires_at > $2`, [userId, now])
      return rows.map((row) => row.upload_expires_at)
    },

    async insertUpload(upload) {
      const { rows } = await client.query<PhotoRow>(
        `INSERT INTO public.lot_photos AS p (lot_id, uploaded_by, position, status, created_at, upload_expires_at)
         VALUES ($1, $2, $3, 'uploading', $4, $5) RETURNING ${PHOTO_COLUMNS}`,
        [lot.id, upload.uploadedBy, upload.position, upload.createdAt, upload.expiresAt])
      return toPhoto(rows[0]!)
    },

    async confirmUpload(photoId, sourceBytes, now) {
      if (!UUID_PATTERN.test(photoId)) return null
      const { rows } = await client.query<PhotoRow>(
        `UPDATE public.lot_photos AS p SET status = 'pending', source_bytes = $3
         WHERE p.public_id = $1 AND p.lot_id = $2 AND p.status = 'uploading' AND p.upload_expires_at > $4
         RETURNING ${PHOTO_COLUMNS}`, [photoId, lot.id, sourceBytes, now])
      return rows[0] ? toPhoto(rows[0]) : null
    },

    async removePhoto(photoId, at) {
      if (!UUID_PATTERN.test(photoId)) return false
      const { rowCount } = await client.query(
        `UPDATE public.lot_photos SET status = 'removed', removed_at = $3, claimed_until = NULL
         WHERE public_id = $1 AND lot_id = $2 AND status <> 'removed'`, [photoId, lot.id, at])
      return rowCount === 1
    },
  }
}

export function createPhotoRepository(pool: Pool): PhotoRepository {
  return {
    async withLotPhotos(lotPublicId, operate) {
      return withTransaction(pool, async (client) => {
        // E1 H p. 20: esperar un bloqueo como máximo 2 s.
        await client.query("SET LOCAL lock_timeout = '2s'")
        const lot = await findLot(client, lotPublicId, true)
        if (lot === null) {
          return operate(null, {
            isMemberOfEstablishment: async () => false, listActivePhotos: async () => [],
            activeUploadsOf: async () => [], insertUpload: async () => { throw new Error("Lote inexistente") },
            confirmUpload: async () => null, removePhoto: async () => false,
          })
        }
        return operate(toLot(lot), createWriter(client, lot))
      })
    },

    async findLotPhotos(lotPublicId) {
      const lot = await findLot(pool, lotPublicId, false)
      if (lot === null) return null
      const { rows } = await pool.query<PhotoRow>(
        `SELECT ${PHOTO_COLUMNS} FROM public.lot_photos p
         WHERE p.lot_id = $1 AND p.status <> 'removed' ORDER BY p.position`, [lot.id])
      return { lot: toLot(lot), photos: rows.map(toPhoto) }
    },

    isMemberOfEstablishment: (userId, establishmentId) => membershipExists(pool, userId, establishmentId),

    async claimNextPending(now, claimedUntil) {
      // El reclamo se confirma de inmediato: la validación ocurre sin bloqueos abiertos.
      const { rows } = await pool.query<{ public_id: string; attempts: number; source_bytes: number }>(
        `UPDATE public.lot_photos SET attempts = attempts + 1, claimed_until = $2
         WHERE id = (SELECT id FROM public.lot_photos
                     WHERE status = 'pending' AND (claimed_until IS NULL OR claimed_until <= $1)
                     ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING public_id::text, attempts, source_bytes`, [now, claimedUntil])
      const row = rows[0]
      return row ? { publicId: row.public_id, attempts: row.attempts, sourceBytes: row.source_bytes } : null
    },

    async finishProcessing(photoId, result, at) {
      const { rowCount } = await pool.query(
        `UPDATE public.lot_photos SET status = $2, format = $3, width = $4, height = $5,
           rejection_reason = $6, processed_at = $7, claimed_until = NULL
         WHERE public_id = $1 AND status = 'pending'`,
        [photoId, result.status, result.format ?? null, result.width ?? null, result.height ?? null,
          result.rejectionReason ?? null, at])
      return rowCount === 1
    },

    async markUploadDeleted(photoId, at) {
      await pool.query("UPDATE public.lot_photos SET upload_deleted_at = $2 WHERE public_id = $1 AND upload_deleted_at IS NULL",
        [photoId, at])
    },

    async markObjectsDeleted(photoId, at) {
      await pool.query(
        `UPDATE public.lot_photos SET objects_deleted_at = $2, upload_deleted_at = COALESCE(upload_deleted_at, $2)
         WHERE public_id = $1 AND status = 'removed' AND objects_deleted_at IS NULL`, [photoId, at])
    },

    async expireUpload(photoId, before, at) {
      const { rowCount } = await pool.query(
        `UPDATE public.lot_photos SET status = 'removed', removed_at = $3
         WHERE public_id = $1 AND status = 'uploading' AND upload_expires_at < $2`, [photoId, before, at])
      return rowCount === 1
    },

    async listCleanup(expiredBefore, limit) {
      const { rows } = await pool.query<{ public_id: string; kind: CleanupItem["kind"] }>(
        `SELECT public_id::text,
           CASE WHEN status = 'uploading' THEN 'expired_upload' WHEN status = 'removed' THEN 'removed' ELSE 'processed' END AS kind
         FROM public.lot_photos
         WHERE (status = 'removed' AND objects_deleted_at IS NULL)
            OR (status IN ('ready', 'rejected') AND upload_deleted_at IS NULL)
            OR (status = 'uploading' AND upload_expires_at < $1)
         ORDER BY id LIMIT $2`, [expiredBefore, limit])
      return rows.map((row) => ({ publicId: row.public_id, kind: row.kind }))
    },
  }
}
