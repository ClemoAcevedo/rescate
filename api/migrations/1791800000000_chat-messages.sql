-- Up Migration
-- K037 · chat de la reserva (RF13, ADR 0016). La conversación es el conjunto de mensajes
-- de una reserva y aparece con el primero, así que no tiene tabla propia. Cada mensaje
-- guarda autor, secuencia y la clave de envío de quien lo escribió. La retención borra
-- solo el texto y conserva la fila como resultado idempotente del envío.
CREATE TABLE public.chat_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL DEFAULT gen_random_uuid() CONSTRAINT chat_messages_public_id_key UNIQUE,
  commitment_id bigint NOT NULL REFERENCES public.commitments(id),
  author_user_id bigint NOT NULL REFERENCES public.users(id),
  sequence integer NOT NULL,
  idempotency_key uuid NOT NULL,
  -- Queda en NULL cuando vence la retención
  body text,
  created_at timestamptz NOT NULL,
  CONSTRAINT chat_messages_sequence_check CHECK (sequence > 0),
  CONSTRAINT chat_messages_body_check CHECK (body IS NULL OR (btrim(body) <> '' AND char_length(body) <= 1000)),
  -- La secuencia se asigna bajo el bloqueo del lote y esta unicidad la respalda
  CONSTRAINT chat_messages_sequence_key UNIQUE (commitment_id, sequence),
  -- Reintentar con la misma clave nunca crea otro mensaje
  CONSTRAINT chat_messages_author_idempotency_key UNIQUE (author_user_id, idempotency_key)
);

-- Cada mensaje avisa a la otra parte (anexos A p. 2 y C p. 5). Un mensaje del titular le
-- llega a todos los operadores del local, así que la unicidad del evento ahora incluye al
-- destinatario. Conserva el nombre para que appendEvent siga igual.
ALTER TABLE public.outbox_events
  DROP CONSTRAINT outbox_events_type_check,
  ADD CONSTRAINT outbox_events_type_check CHECK (event_type IN ('offer_issued', 'offer_expired',
    'reservation_confirmed', 'reservation_cancelled', 'message_from_holder', 'message_from_establishment')),
  DROP CONSTRAINT outbox_events_subject_key,
  ADD CONSTRAINT outbox_events_subject_key UNIQUE (event_type, subject_id, version, recipient_user_id);
ALTER TABLE public.notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('offer_issued', 'offer_expired',
    'reservation_confirmed', 'reservation_cancelled', 'message_from_holder', 'message_from_establishment'));

-- Down Migration
-- Volver atrás exige que no queden avisos ni eventos de mensajes.
ALTER TABLE public.notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN
    ('offer_issued', 'offer_expired', 'reservation_confirmed', 'reservation_cancelled'));
ALTER TABLE public.outbox_events
  DROP CONSTRAINT outbox_events_subject_key,
  ADD CONSTRAINT outbox_events_subject_key UNIQUE (event_type, subject_id, version),
  DROP CONSTRAINT outbox_events_type_check,
  ADD CONSTRAINT outbox_events_type_check CHECK (event_type IN
    ('offer_issued', 'offer_expired', 'reservation_confirmed', 'reservation_cancelled'));
DROP TABLE public.chat_messages;
