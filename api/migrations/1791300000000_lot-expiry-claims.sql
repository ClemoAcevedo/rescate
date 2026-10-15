-- Up Migration
-- K028: reclamo de los vencimientos de cada lote (RF08). La API decide con el cierre
-- del lote y la hora de cada oferta aunque el trabajador esté detenido; estas columnas
-- solo coordinan quién registra el efecto. Un trabajador reclama el lote hasta
-- expiry_claimed_until (concesión); si muere, otro lo retoma al vencer. expiry_attempts
-- cuenta los reclamos fallidos o en curso, vuelve a 0 al registrar, y Application deja
-- de reclamar al alcanzar su límite. El cierre registrado es status = 'expired' (ADR 0008).
ALTER TABLE public.lots
  ADD COLUMN expiry_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN expiry_claimed_until timestamptz,
  ADD CONSTRAINT lots_expiry_attempts_check CHECK (expiry_attempts >= 0);

-- Ofertas pendientes de vencer, en orden de vencimiento. Los cierres usan
-- lots_public_search_idx (pickup_ends_at de los lotes publicados).
CREATE INDEX waitlist_entries_offer_expiry_idx ON public.waitlist_entries (offer_expires_at)
  WHERE status = 'offered';

-- Down Migration
DROP INDEX public.waitlist_entries_offer_expiry_idx;
ALTER TABLE public.lots
  DROP CONSTRAINT lots_expiry_attempts_check,
  DROP COLUMN expiry_claimed_until,
  DROP COLUMN expiry_attempts;
