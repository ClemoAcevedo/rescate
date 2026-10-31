-- Up Migration
-- La pausa suspende nuevas asignaciones sin cancelar compromisos ni cambiar el cierre.
ALTER TABLE public.lots ADD COLUMN paused_at timestamptz,
  ADD CONSTRAINT lots_paused_check CHECK (paused_at IS NULL OR status = 'published');
CREATE TYPE public.lot_operation AS ENUM ('reduce_stock', 'pause', 'resume', 'withdraw');
CREATE TABLE public.lot_operations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  lot_id bigint NOT NULL REFERENCES public.lots(id),
  user_id bigint NOT NULL REFERENCES public.users(id),
  idempotency_key uuid NOT NULL,
  action public.lot_operation NOT NULL,
  quantity integer,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  expected_version integer NOT NULL CHECK (expected_version > 0),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (user_id, idempotency_key),
  CHECK ((action = 'reduce_stock' AND quantity IS NOT NULL AND quantity > 0) OR (action <> 'reduce_stock' AND quantity IS NULL))
);
CREATE INDEX lot_operations_lot_idx ON public.lot_operations(lot_id, id DESC);
-- El orden de las fotos no impone un máximo de negocio. Application fija el cupo.
ALTER TABLE public.lot_photos DROP CONSTRAINT lot_photos_position_check,
  ADD CONSTRAINT lot_photos_position_check CHECK (position > 0);
-- Down Migration
-- Evitar perder una pausa o fotos que el esquema anterior no puede representar.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.lots WHERE paused_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.lot_photos WHERE position > 3) THEN
    RAISE EXCEPTION 'Rollback requiere lotes sin pausa y fotografías representables en posiciones 1 a 3; revisar respaldo compatible antes de continuar';
  END IF;
END $$;
ALTER TABLE public.lot_photos DROP CONSTRAINT lot_photos_position_check,
  ADD CONSTRAINT lot_photos_position_check CHECK (position BETWEEN 1 AND 3);
DROP TABLE public.lot_operations;
DROP TYPE public.lot_operation;
ALTER TABLE public.lots DROP CONSTRAINT lots_paused_check, DROP COLUMN paused_at;
