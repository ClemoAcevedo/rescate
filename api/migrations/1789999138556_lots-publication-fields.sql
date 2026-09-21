-- Up Migration
-- K010: identificador público opaco, versión optimista del borrador y marca de
-- última edición. Decisiones y alcance en docs/k010-publicacion-lotes.md.
-- No cambia las columnas de K003 ni introduce estados nuevos del lote.

ALTER TABLE public.lots
  ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE public.lots
  ADD CONSTRAINT lots_public_id_key UNIQUE (public_id),
  ADD CONSTRAINT lots_version_check CHECK (version > 0);

-- RF02/RF03: el panel del operador lista los lotes de su establecimiento por
-- fecha de creación. Índice para esa consulta, no para la búsqueda pública.
CREATE INDEX lots_establishment_created_idx
  ON public.lots (establishment_id, created_at DESC);

-- Down Migration
-- Solo K010. Las cinco tablas de K003 y la tabla técnica de K002 permanecen.
DROP INDEX public.lots_establishment_created_idx;

ALTER TABLE public.lots
  DROP CONSTRAINT lots_version_check,
  DROP CONSTRAINT lots_public_id_key;

ALTER TABLE public.lots
  DROP COLUMN updated_at,
  DROP COLUMN version,
  DROP COLUMN public_id;
