-- Up Migration
-- K027: cola FIFO y ofertas (RF07, ADR 0002, ADR 0010). Una solicitud en espera no
-- posee packs; al recibir una oferta retiene `offered_quantity` (F → O) y termina
-- aceptada (O → R, con su reserva), rechazada, vencida o retirada por su titular.
-- El orden FIFO es el de `id`, que se asigna bajo el bloqueo del lote.
CREATE TABLE public.waitlist_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL DEFAULT gen_random_uuid() CONSTRAINT waitlist_entries_public_id_key UNIQUE,
  user_id bigint NOT NULL REFERENCES public.users(id),
  lot_id bigint NOT NULL REFERENCES public.lots(id),
  requested_quantity integer NOT NULL,
  status text NOT NULL DEFAULT 'waiting',
  offered_quantity integer,
  offered_at timestamptz,
  offer_expires_at timestamptz,
  commitment_id bigint CONSTRAINT waitlist_entries_commitment_key UNIQUE REFERENCES public.commitments(id),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at timestamptz,
  CONSTRAINT waitlist_entries_user_idempotency_key UNIQUE (user_id, idempotency_key),
  CONSTRAINT waitlist_entries_requested_check CHECK (requested_quantity > 0),
  CONSTRAINT waitlist_entries_status_check
    CHECK (status IN ('waiting', 'offered', 'accepted', 'declined', 'expired', 'left')),
  -- Una oferta nunca pide más de lo solicitado; sus tres datos existen juntos.
  CONSTRAINT waitlist_entries_offer_check CHECK (
    (offered_quantity IS NULL AND offered_at IS NULL AND offer_expires_at IS NULL)
    OR (offered_quantity BETWEEN 1 AND requested_quantity AND offered_at IS NOT NULL
        AND offer_expires_at > offered_at)),
  CONSTRAINT waitlist_entries_state_check CHECK (
    (status = 'offered') <= (offered_quantity IS NOT NULL)
    AND (status IN ('waiting', 'left')) <= (offered_quantity IS NULL)
    AND (status IN ('accepted', 'declined')) <= (offered_quantity IS NOT NULL)),
  CONSTRAINT waitlist_entries_ended_check CHECK ((status IN ('waiting', 'offered')) = (ended_at IS NULL)),
  CONSTRAINT waitlist_entries_commitment_check CHECK ((status = 'accepted') = (commitment_id IS NOT NULL))
);

-- RF04: una solicitud abierta por usuario y lote. La convivencia con la reserva
-- confirmada se comprueba bajo el bloqueo del lote, porque cruza dos tablas.
CREATE UNIQUE INDEX waitlist_entries_open_user_lot_key
  ON public.waitlist_entries (user_id, lot_id) WHERE status IN ('waiting', 'offered');
CREATE INDEX waitlist_entries_lot_waiting_idx ON public.waitlist_entries (lot_id, id) WHERE status = 'waiting';
CREATE INDEX waitlist_entries_lot_offered_idx ON public.waitlist_entries (lot_id) WHERE status = 'offered';
CREATE INDEX waitlist_entries_user_idx ON public.waitlist_entries (user_id, created_at DESC, id DESC);

-- Down Migration
DROP TABLE public.waitlist_entries;
