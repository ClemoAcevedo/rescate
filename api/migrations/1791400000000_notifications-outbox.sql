-- Up Migration
-- K030: avisos internos (RF09) con outbox transaccional (anexos B y H, ADR 0012).
-- Cada transición inserta su evento en la misma transacción; el worker genera los
-- avisos por tandas y reintenta sin duplicar. Leer un aviso no cambia compromisos.
CREATE TABLE public.outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL,
  -- Fila que cambió: solicitud de la cola (ofertas) o reserva (confirmación y cancelación).
  subject_id bigint NOT NULL,
  version integer NOT NULL DEFAULT 1,
  recipient_user_id bigint NOT NULL REFERENCES public.users(id),
  -- Datos que el aviso muestra, tomados bajo el bloqueo de la transición. Nunca códigos de retiro.
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,
  claimed_until timestamptz,
  processed_at timestamptz,
  last_error text,
  CONSTRAINT outbox_events_type_check CHECK (event_type IN
    ('offer_issued', 'offer_expired', 'reservation_confirmed', 'reservation_cancelled')),
  CONSTRAINT outbox_events_status_check CHECK (status IN ('pending', 'processed', 'failed')),
  CONSTRAINT outbox_events_version_check CHECK (version > 0),
  CONSTRAINT outbox_events_attempts_check CHECK (attempts >= 0),
  CONSTRAINT outbox_events_payload_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_events_processed_check CHECK ((status = 'processed') = (processed_at IS NOT NULL)),
  -- Una transición ocurre una sola vez por fila y versión: repetirla no crea otro evento.
  CONSTRAINT outbox_events_subject_key UNIQUE (event_type, subject_id, version)
);
CREATE INDEX outbox_events_pending_idx ON public.outbox_events (available_at, id) WHERE status = 'pending';

CREATE TABLE public.notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL DEFAULT gen_random_uuid() CONSTRAINT notifications_public_id_key UNIQUE,
  event_id bigint NOT NULL REFERENCES public.outbox_events(id),
  user_id bigint NOT NULL REFERENCES public.users(id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  read_at timestamptz,
  CONSTRAINT notifications_kind_check CHECK (kind IN
    ('offer_issued', 'offer_expired', 'reservation_confirmed', 'reservation_cancelled')),
  CONSTRAINT notifications_read_check CHECK (read_at IS NULL OR read_at >= created_at),
  -- Criterio K030: cada evento y destinatario produce un solo aviso, aun con reintentos.
  CONSTRAINT notifications_event_user_key UNIQUE (event_id, user_id)
);
CREATE INDEX notifications_user_idx ON public.notifications (user_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread_idx ON public.notifications (user_id) WHERE read_at IS NULL;

-- Down Migration
DROP TABLE public.notifications;
DROP TABLE public.outbox_events;
