-- Up Migration
-- K044: la versión y sus destinatarios son la intención durable del aviso. El worker
-- los convierte en eventos por tandas, sin mantener el bloqueo del lote durante el envío.
ALTER TABLE public.incident_versions
  ADD COLUMN close_lot boolean NOT NULL DEFAULT false,
  ADD COLUMN lot_closed boolean NOT NULL DEFAULT false;
-- Las versiones anteriores conservan el cierre efectivo conocido al publicarlas.
UPDATE public.incident_versions v SET lot_closed =
  l.closed_at <= v.created_at OR l.pickup_ends_at <= v.created_at
FROM public.incidents i JOIN public.lots l ON l.id=i.lot_id
WHERE i.id=v.incident_id AND (l.closed_at IS NOT NULL OR l.pickup_ends_at <= v.created_at);
ALTER TABLE public.incident_recipients
  ADD COLUMN outbox_event_id bigint UNIQUE REFERENCES public.outbox_events(id);
CREATE INDEX incident_recipients_pending_idx ON public.incident_recipients (incident_id, version, user_id)
  WHERE outbox_event_id IS NULL;
ALTER TABLE public.outbox_events
  DROP CONSTRAINT outbox_events_type_check,
  ADD CONSTRAINT outbox_events_type_check CHECK (event_type IN ('offer_issued', 'offer_expired',
    'reservation_confirmed', 'reservation_cancelled', 'message_from_holder', 'message_from_establishment', 'incident_version'));
ALTER TABLE public.notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('offer_issued', 'offer_expired',
    'reservation_confirmed', 'reservation_cancelled', 'message_from_holder', 'message_from_establishment', 'incident_version'));

-- Down Migration
-- Como en K037, el rollback exige retirar primero los eventos del tipo que desaparece.
ALTER TABLE public.notifications
  DROP CONSTRAINT notifications_kind_check,
  ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('offer_issued', 'offer_expired',
    'reservation_confirmed', 'reservation_cancelled', 'message_from_holder', 'message_from_establishment'));
ALTER TABLE public.outbox_events
  DROP CONSTRAINT outbox_events_type_check,
  ADD CONSTRAINT outbox_events_type_check CHECK (event_type IN ('offer_issued', 'offer_expired',
    'reservation_confirmed', 'reservation_cancelled', 'message_from_holder', 'message_from_establishment'));
DROP INDEX public.incident_recipients_pending_idx;
ALTER TABLE public.incident_recipients DROP COLUMN outbox_event_id;
ALTER TABLE public.incident_versions DROP COLUMN close_lot, DROP COLUMN lot_closed;
