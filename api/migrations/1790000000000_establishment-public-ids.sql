-- Up Migration
-- K010: identidad HTTP opaca, separada de la PK y de la autorización.
ALTER TABLE public.establishments
  ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD CONSTRAINT establishments_public_id_key UNIQUE (public_id);

-- Down Migration
ALTER TABLE public.establishments
  DROP CONSTRAINT establishments_public_id_key,
  DROP COLUMN public_id;
