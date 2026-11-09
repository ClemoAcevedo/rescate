-- Up Migration
-- K043: incidencias del lote (RF11, anexos H p. 20 e I p. 26, ADR 0020). Un reporte no
-- tiene efectos; cada publicación crea una versión y fija sus destinatarios bajo el
-- bloqueo del lote. Los avisos de la bandeja se generan a partir de esas filas.
CREATE TYPE public.incident_status AS ENUM ('reported', 'open', 'following', 'resolved');
-- El orden importa: min() conserva el vínculo más fuerte de una persona con el lote.
CREATE TYPE public.incident_recipient_relation AS ENUM ('received', 'committed', 'operator');

CREATE TABLE public.incidents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL DEFAULT gen_random_uuid() CONSTRAINT incidents_public_id_key UNIQUE,
  lot_id bigint NOT NULL REFERENCES public.lots(id),
  reported_by bigint NOT NULL REFERENCES public.users(id),
  report_reason text NOT NULL,
  status public.incident_status NOT NULL DEFAULT 'reported',
  version integer NOT NULL DEFAULT 0,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT incidents_report_reason_check CHECK (length(btrim(report_reason)) BETWEEN 1 AND 2000),
  CONSTRAINT incidents_version_check CHECK ((status = 'reported') = (version = 0) AND version >= 0),
  CONSTRAINT incidents_reporter_idempotency_key UNIQUE (reported_by, idempotency_key)
);
CREATE INDEX incidents_lot_idx ON public.incidents (lot_id, id DESC);

CREATE TABLE public.incident_versions (
  incident_id bigint NOT NULL REFERENCES public.incidents(id),
  version integer NOT NULL,
  status public.incident_status NOT NULL,
  reason text NOT NULL,
  instructions text NOT NULL,
  published_by bigint NOT NULL REFERENCES public.users(id),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (incident_id, version),
  CONSTRAINT incident_versions_reason_check CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT incident_versions_instructions_check CHECK (length(btrim(instructions)) BETWEEN 1 AND 2000),
  CONSTRAINT incident_versions_version_check CHECK (version > 0),
  -- Publicar crea la versión 1; toda versión posterior es seguimiento o resolución.
  CONSTRAINT incident_versions_status_check CHECK (status <> 'reported' AND (status = 'open') = (version = 1)),
  CONSTRAINT incident_versions_publisher_idempotency_key UNIQUE (published_by, idempotency_key)
);

CREATE TABLE public.incident_recipients (
  incident_id bigint NOT NULL,
  version integer NOT NULL,
  user_id bigint NOT NULL REFERENCES public.users(id),
  relation public.incident_recipient_relation NOT NULL,
  created_at timestamptz NOT NULL,
  -- Anexos I p. 26: una persona por incidencia y versión, aun con una reserva concurrente.
  PRIMARY KEY (incident_id, version, user_id),
  FOREIGN KEY (incident_id, version) REFERENCES public.incident_versions (incident_id, version)
);
CREATE INDEX incident_recipients_user_idx ON public.incident_recipients (user_id);

-- Down Migration
DROP TABLE public.incident_recipients;
DROP TABLE public.incident_versions;
DROP TABLE public.incidents;
DROP TYPE public.incident_recipient_relation;
DROP TYPE public.incident_status;
