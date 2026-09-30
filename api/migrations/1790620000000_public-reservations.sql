-- Up Migration
-- La identidad de la reserva y de una intención de cliente son opacas y únicas.
ALTER TABLE public.commitments
  ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN idempotency_key uuid;
ALTER TABLE public.commitments
  ADD CONSTRAINT commitments_public_id_key UNIQUE (public_id),
  ADD CONSTRAINT commitments_user_idempotency_key UNIQUE (user_id, idempotency_key);
CREATE INDEX lots_public_search_idx
  ON public.lots (pickup_ends_at, published_at DESC, id DESC)
  WHERE status = 'published';
CREATE INDEX commitments_lot_confirmed_idx
  ON public.commitments (lot_id) WHERE status = 'confirmed';

-- Down Migration
DROP INDEX public.commitments_lot_confirmed_idx;
DROP INDEX public.lots_public_search_idx;
ALTER TABLE public.commitments
  DROP CONSTRAINT commitments_user_idempotency_key,
  DROP CONSTRAINT commitments_public_id_key,
  DROP COLUMN idempotency_key,
  DROP COLUMN public_id;
