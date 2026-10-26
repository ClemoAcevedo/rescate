-- Up Migration
-- Feedback E2: el estado del lote pasa a ser un enum y un lote cerrado no se borra.
-- Vencido (K028) y retirado (K044) son cierres lógicos: la fila, sus fotos y sus
-- reservas siguen existiendo para historial y avisos, con closed_at como marca.
CREATE TYPE public.lot_status AS ENUM ('draft', 'published', 'expired', 'withdrawn');

-- Los índices parciales y CHECK comparan status con text; se recrean con el tipo nuevo.
DROP INDEX public.lots_public_search_idx, public.lots_public_location_idx;
ALTER TABLE public.lots
  DROP CONSTRAINT lots_status_check,
  DROP CONSTRAINT lots_publication_check,
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN status TYPE public.lot_status USING status::public.lot_status,
  ALTER COLUMN status SET DEFAULT 'draft',
  ADD COLUMN closed_at timestamptz,
  ADD CONSTRAINT lots_publication_check CHECK ((status = 'draft') = (published_at IS NULL)),
  ADD CONSTRAINT lots_closed_check CHECK ((status IN ('expired', 'withdrawn')) = (closed_at IS NOT NULL));
CREATE INDEX lots_public_search_idx
  ON public.lots (pickup_ends_at, published_at DESC, id DESC)
  WHERE status = 'published';
CREATE INDEX lots_public_location_idx ON public.lots USING gist
  ((ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography))
  WHERE status = 'published';

-- Down Migration
-- Volver atrás exige que no queden lotes cerrados.
DROP INDEX public.lots_public_search_idx, public.lots_public_location_idx;
ALTER TABLE public.lots
  DROP CONSTRAINT lots_closed_check,
  DROP CONSTRAINT lots_publication_check,
  DROP COLUMN closed_at,
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN status TYPE text USING status::text,
  ALTER COLUMN status SET DEFAULT 'draft',
  ADD CONSTRAINT lots_status_check CHECK (status IN ('draft', 'published')),
  ADD CONSTRAINT lots_publication_check CHECK (
    (status = 'draft' AND published_at IS NULL) OR
    (status = 'published' AND published_at IS NOT NULL)
  );
DROP TYPE public.lot_status;
CREATE INDEX lots_public_search_idx
  ON public.lots (pickup_ends_at, published_at DESC, id DESC)
  WHERE status = 'published';
CREATE INDEX lots_public_location_idx ON public.lots USING gist
  ((ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography))
  WHERE status = 'published';
