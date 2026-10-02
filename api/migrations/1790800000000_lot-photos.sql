-- Up Migration
-- K014: referencias y estado de las fotos de un lote (anexos I p. 25). Los bytes
-- viven en almacenamiento de objetos; las claves se derivan de public_id.
CREATE TABLE public.lot_photos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL DEFAULT gen_random_uuid(),
  lot_id bigint NOT NULL REFERENCES public.lots (id),
  uploaded_by bigint NOT NULL REFERENCES public.users (id),
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  status text NOT NULL CHECK (status IN ('uploading', 'pending', 'ready', 'rejected', 'removed')),
  created_at timestamptz NOT NULL,
  upload_expires_at timestamptz NOT NULL CHECK (upload_expires_at > created_at),
  source_bytes integer CHECK (source_bytes BETWEEN 1 AND 5242880),
  format text CHECK (format IN ('jpeg', 'png', 'webp')),
  width integer CHECK (width BETWEEN 1 AND 1600),
  height integer CHECK (height BETWEEN 1 AND 1600),
  rejection_reason text CHECK (rejection_reason IN (
    'unsupported_format', 'animated', 'too_many_pixels', 'undecodable', 'output_too_large', 'processing_failed')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_until timestamptz,
  processed_at timestamptz,
  removed_at timestamptz,
  upload_deleted_at timestamptz,
  objects_deleted_at timestamptz,
  CONSTRAINT lot_photos_public_id_key UNIQUE (public_id),
  -- Una foto lista conoce su formato y dimensiones.
  CONSTRAINT lot_photos_ready_check CHECK (status <> 'ready'
    OR (format IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND processed_at IS NOT NULL)),
  -- Una foto quitada conserva el motivo que tuvo al rechazarse.
  CONSTRAINT lot_photos_rejected_check CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL),
  CONSTRAINT lot_photos_reason_check CHECK (rejection_reason IS NULL OR status IN ('rejected', 'removed')),
  CONSTRAINT lot_photos_received_check CHECK (status IN ('uploading', 'removed') OR source_bytes IS NOT NULL),
  CONSTRAINT lot_photos_removed_check CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);
-- Hasta tres fotos activas por lote, cada una en su posición.
CREATE UNIQUE INDEX lot_photos_lot_position_key
  ON public.lot_photos (lot_id, position) WHERE status <> 'removed';
CREATE INDEX lot_photos_pending_idx
  ON public.lot_photos (created_at, id) WHERE status = 'pending';
CREATE INDEX lot_photos_uploader_idx
  ON public.lot_photos (uploaded_by) WHERE status = 'uploading';
-- Objetos que el worker todavía debe borrar.
CREATE INDEX lot_photos_cleanup_idx ON public.lot_photos (id)
  WHERE (status = 'removed' AND objects_deleted_at IS NULL)
     OR (status IN ('ready', 'rejected') AND upload_deleted_at IS NULL)
     OR status = 'uploading';

-- Down Migration
-- Elimina solo referencias: los objetos remotos deben borrarse antes por el worker.
DROP TABLE public.lot_photos;
