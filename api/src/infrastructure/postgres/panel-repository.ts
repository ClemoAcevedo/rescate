// K035 · Infrastructure: lecturas del panel del establecimiento con SQL parametrizado.
// No decide autorización. Un lote publicado cuya ventana terminó se trata como cerrado
// aunque el trabajador aún no lo registre: lo vigente no depende de su retraso (RF08).

import type {
  ActivityEvent, ActivityKind, OpenLot, OperatorCommitment, PanelRepository, PeriodCounts,
} from "../../application/panel/ports.js"
import type { ReservationStatus } from "../../domain/reservations.js"
import type { WaitlistStatus } from "../../domain/waitlist.js"
import { withTransaction } from "./pool.js"
import type { Pool } from "./pool.js"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAGE_SIZE = 20

/** Cierre vigente: el registrado o, sin registro, el fin de la ventana ya alcanzado. */
const CLOSED_AT = `CASE WHEN l.status IN ('expired', 'withdrawn') THEN l.closed_at
  WHEN l.status = 'published' AND l.pickup_ends_at <= $2 THEN l.pickup_ends_at END`

interface OpenLotRow {
  public_id: string
  description: string
  quantity: number
  pickup_starts_at: Date
  pickup_ends_at: Date
  free_quantity: number
  offered_quantity: number
  reserved_quantity: number
  delivered_quantity: number
  expired_quantity: number
  stale_offered: number
  active_offers: number
  waiting_requests: number
  confirmed_reservations: number
}

function toOpenLot(row: OpenLotRow): OpenLot {
  return {
    publicId: row.public_id, description: row.description, quantity: row.quantity,
    pickupStartsAt: row.pickup_starts_at, pickupEndsAt: row.pickup_ends_at,
    // Una oferta vencida sin registrar ya no retiene packs: vuelve a libres (anexos B p. 4).
    inventory: {
      free: row.free_quantity + row.stale_offered,
      offered: row.offered_quantity - row.stale_offered,
      reserved: row.reserved_quantity,
      delivered: row.delivered_quantity,
      unassignable: row.expired_quantity,
    },
    confirmedReservations: row.confirmed_reservations,
    activeOffers: row.active_offers,
    waitingRequests: row.waiting_requests,
  }
}

interface PeriodRow {
  closed_lots: number
  published_packs: string
  delivered_packs: string
  confirmed: number
  cancelled: number
  expired: number
  delivered: number
  open_lots: number
  draft_lots: number
}

interface CommitmentRow {
  kind: "reservation" | "waitlist"
  public_id: string
  status: string
  quantity: number
  offered_quantity: number | null
  offer_expires_at: Date | null
  created_at: Date
  ended_at: Date | null
  pickup_ends_at: Date
  lot_id: string
  lot_description: string
}

interface ActivityRow {
  id: string
  kind: ActivityKind
  at: Date
  quantity: number | null
  lot_id: string
  lot_description: string
}

export function createPanelRepository(pool: Pool): PanelRepository {
  return {
    async findEstablishment(publicId) {
      if (!UUID_PATTERN.test(publicId)) return null
      const { rows } = await pool.query<{ id: string; publicId: string; name: string; timeZone: string }>(
        `SELECT id::text, public_id::text AS "publicId", name, time_zone AS "timeZone"
         FROM public.establishments WHERE public_id = $1`, [publicId])
      return rows[0] ?? null
    },

    async isMemberOfEstablishment(userId, establishmentId) {
      const { rows } = await pool.query(
        "SELECT 1 FROM public.memberships WHERE user_id = $1 AND establishment_id = $2", [userId, establishmentId])
      return rows.length > 0
    },

    async findLot(establishmentId, lotPublicId) {
      if (!UUID_PATTERN.test(lotPublicId)) return null
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id::text FROM public.lots WHERE public_id = $1 AND establishment_id = $2", [lotPublicId, establishmentId])
      return rows[0]?.id ?? null
    },

    async readSummary(establishmentId, period, timeZone, now) {
      // Una foto de la base para ambos bloques: los totales no mezclan instantes.
      return withTransaction(pool, async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        const open = await client.query<OpenLotRow>(
          `SELECT l.public_id::text, l.description, l.quantity, l.pickup_starts_at, l.pickup_ends_at,
             l.free_quantity, l.offered_quantity, l.reserved_quantity, l.delivered_quantity, l.expired_quantity,
             (SELECT coalesce(sum(w.offered_quantity), 0) FROM public.waitlist_entries w
               WHERE w.lot_id = l.id AND w.status = 'offered' AND w.offer_expires_at <= $2)::int AS stale_offered,
             (SELECT count(*) FROM public.waitlist_entries w
               WHERE w.lot_id = l.id AND w.status = 'offered' AND w.offer_expires_at > $2)::int AS active_offers,
             (SELECT count(*) FROM public.waitlist_entries w
               WHERE w.lot_id = l.id AND w.status = 'waiting')::int AS waiting_requests,
             (SELECT count(*) FROM public.commitments c
               WHERE c.lot_id = l.id AND c.status = 'confirmed')::int AS confirmed_reservations
           FROM public.lots l
           WHERE l.establishment_id = $1 AND l.status = 'published' AND l.pickup_ends_at > $2
           ORDER BY l.pickup_ends_at, l.id`, [establishmentId, now])
        // Días locales del establecimiento: [desde 00:00, hasta + 1 día 00:00) en su zona.
        const counts = await client.query<PeriodRow>(
          `WITH scoped AS (
             SELECT l.id, l.status, l.quantity, l.delivered_quantity, ${CLOSED_AT} AS closed_at
             FROM public.lots l WHERE l.establishment_id = $1
           ), closed AS (
             SELECT s.* FROM scoped s
             WHERE s.closed_at >= ($3::date)::timestamp AT TIME ZONE $5
               AND s.closed_at < ($4::date + 1)::timestamp AT TIME ZONE $5
           ), reservations AS (
             SELECT c.status FROM public.commitments c JOIN closed s ON s.id = c.lot_id
           )
           SELECT
             (SELECT count(*) FROM closed)::int AS closed_lots,
             (SELECT coalesce(sum(quantity), 0) FROM closed)::text AS published_packs,
             (SELECT coalesce(sum(delivered_quantity), 0) FROM closed)::text AS delivered_packs,
             (SELECT count(*) FROM reservations)::int AS confirmed,
             (SELECT count(*) FROM reservations WHERE status = 'cancelled')::int AS cancelled,
             -- En un lote cerrado, una reserva aún confirmada ya venció con el cierre.
             (SELECT count(*) FROM reservations WHERE status IN ('expired', 'confirmed'))::int AS expired,
             (SELECT count(*) FROM reservations WHERE status = 'delivered')::int AS delivered,
             (SELECT count(*) FROM scoped WHERE status = 'published' AND closed_at IS NULL)::int AS open_lots,
             (SELECT count(*) FROM scoped WHERE status = 'draft')::int AS draft_lots`,
          [establishmentId, now, period.from, period.to, timeZone])
        const row = counts.rows[0]!
        const publishedPacks = Number(row.published_packs)
        const deliveredPacks = Number(row.delivered_packs)
        const result: PeriodCounts = {
          closedLots: row.closed_lots,
          publishedPacks,
          deliveredPacks,
          // Un lote cerrado conserva solo lo retirado: el resto quedó no asignable (Q = E + X).
          unassignablePacks: publishedPacks - deliveredPacks,
          reservations: { confirmed: row.confirmed, cancelled: row.cancelled, expired: row.expired, delivered: row.delivered },
          excluded: { openLots: row.open_lots, draftLots: row.draft_lots },
        }
        return { openLots: open.rows.map(toOpenLot), period: result }
      })
    },

    async listCommitments(establishmentId, filter, now) {
      // Vigente: reserva confirmada, espera u oferta en plazo, con la ventana del lote abierta.
      const { rows } = await pool.query<CommitmentRow>(
        `SELECT * FROM (
           SELECT 'reservation' AS kind, c.public_id::text, c.status, c.quantity,
             NULL::int AS offered_quantity, NULL::timestamptz AS offer_expires_at, c.created_at, c.ended_at,
             c.id AS row_id, l.pickup_ends_at, l.public_id::text AS lot_id, l.description AS lot_description
           FROM public.commitments c JOIN public.lots l ON l.id = c.lot_id
           WHERE l.establishment_id = $1 AND ($2::bigint IS NULL OR l.id = $2)
             AND ($3::boolean IS NULL OR $3 = (c.status = 'confirmed' AND l.pickup_ends_at > $4))
           UNION ALL
           SELECT 'waitlist', w.public_id::text, w.status, w.requested_quantity,
             w.offered_quantity, w.offer_expires_at, w.created_at, w.ended_at,
             w.id, l.pickup_ends_at, l.public_id::text, l.description
           FROM public.waitlist_entries w JOIN public.lots l ON l.id = w.lot_id
           WHERE l.establishment_id = $1 AND ($2::bigint IS NULL OR l.id = $2)
             AND ($3::boolean IS NULL OR $3 = (l.pickup_ends_at > $4
               AND (w.status = 'waiting' OR (w.status = 'offered' AND w.offer_expires_at > $4))))
         ) items
         ORDER BY created_at DESC, kind, row_id DESC
         LIMIT ${PAGE_SIZE + 1} OFFSET $5`,
        [establishmentId, filter.lotId ?? null, filter.active ?? null, now, (filter.page - 1) * PAGE_SIZE])
      return {
        items: rows.slice(0, PAGE_SIZE).map((row): OperatorCommitment => ({
          publicId: row.public_id, kind: row.kind, status: row.status as ReservationStatus | WaitlistStatus,
          quantity: row.quantity, offeredQuantity: row.offered_quantity, offerExpiresAt: row.offer_expires_at,
          createdAt: row.created_at, endedAt: row.ended_at, pickupEndsAt: row.pickup_ends_at,
          lot: { id: row.lot_id, description: row.lot_description },
        })),
        hasNextPage: rows.length > PAGE_SIZE,
      }
    },

    async listActivity(establishmentId, filter, now) {
      // `stage` ordena hechos simultáneos: el cierre del lote antes que las reservas que vencen con él.
      const { rows } = await pool.query<ActivityRow>(
        `WITH scope AS (
           SELECT l.id, l.public_id::text AS lot_id, l.description, l.status, l.quantity,
             l.published_at, l.closed_at, l.pickup_ends_at
           FROM public.lots l WHERE l.establishment_id = $1 AND ($2::bigint IS NULL OR l.id = $2)
         ), events AS (
           SELECT 'lot_published' AS kind, s.lot_id AS subject, s.published_at AS at, s.quantity, s.lot_id, s.description, 0 AS stage
           FROM scope s WHERE s.published_at IS NOT NULL
           UNION ALL
           SELECT CASE WHEN s.status = 'withdrawn' THEN 'lot_withdrawn' ELSE 'lot_expired' END,
             s.lot_id, coalesce(s.closed_at, s.pickup_ends_at), NULL, s.lot_id, s.description, 9
           FROM scope s WHERE s.status IN ('expired', 'withdrawn') OR (s.status = 'published' AND s.pickup_ends_at <= $3)
           UNION ALL
           -- La reserva que nace de una oferta se informa como oferta aceptada, una sola vez.
           SELECT CASE WHEN EXISTS (SELECT 1 FROM public.waitlist_entries w WHERE w.commitment_id = c.id)
               THEN 'offer_accepted' ELSE 'reservation_confirmed' END,
             c.public_id::text, c.created_at, c.quantity, s.lot_id, s.description, 3
           FROM public.commitments c JOIN scope s ON s.id = c.lot_id
           UNION ALL
           SELECT CASE c.status WHEN 'cancelled' THEN 'reservation_cancelled' WHEN 'delivered' THEN 'pickup_confirmed'
               ELSE 'reservation_expired' END,
             c.public_id::text, coalesce(c.ended_at, s.pickup_ends_at), c.quantity, s.lot_id, s.description, 5
           FROM public.commitments c JOIN scope s ON s.id = c.lot_id
           WHERE c.status <> 'confirmed' OR s.pickup_ends_at <= $3
           UNION ALL
           SELECT 'waitlist_joined', w.public_id::text, w.created_at, w.requested_quantity, s.lot_id, s.description, 1
           FROM public.waitlist_entries w JOIN scope s ON s.id = w.lot_id
           UNION ALL
           SELECT 'offer_issued', w.public_id::text, w.offered_at, w.offered_quantity, s.lot_id, s.description, 2
           FROM public.waitlist_entries w JOIN scope s ON s.id = w.lot_id WHERE w.offered_at IS NOT NULL
           UNION ALL
           -- Fin de la solicitud salvo la aceptación; sin registro, termina a la hora de la oferta o al cierre.
           SELECT CASE w.status WHEN 'declined' THEN 'offer_declined' WHEN 'left' THEN 'waitlist_left'
               ELSE CASE WHEN w.offered_quantity IS NULL THEN 'waitlist_expired' ELSE 'offer_expired' END END,
             w.public_id::text,
             coalesce(w.ended_at, CASE WHEN w.status = 'offered' AND w.offer_expires_at < s.pickup_ends_at
               THEN w.offer_expires_at ELSE s.pickup_ends_at END),
             coalesce(w.offered_quantity, w.requested_quantity), s.lot_id, s.description, 4
           FROM public.waitlist_entries w JOIN scope s ON s.id = w.lot_id
           WHERE w.status IN ('declined', 'expired', 'left')
             OR (w.status = 'offered' AND (w.offer_expires_at <= $3 OR s.pickup_ends_at <= $3))
             OR (w.status = 'waiting' AND s.pickup_ends_at <= $3)
         )
         SELECT kind || ':' || subject AS id, kind, at, quantity, lot_id, description AS lot_description
         FROM events
         ORDER BY at DESC, stage DESC, id DESC
         LIMIT ${PAGE_SIZE + 1} OFFSET $4`,
        [establishmentId, filter.lotId ?? null, now, (filter.page - 1) * PAGE_SIZE])
      return {
        items: rows.slice(0, PAGE_SIZE).map((row): ActivityEvent => ({
          id: row.id, kind: row.kind, at: row.at, quantity: row.quantity,
          lot: { id: row.lot_id, description: row.lot_description },
        })),
        hasNextPage: rows.length > PAGE_SIZE,
      }
    },
  }
}
