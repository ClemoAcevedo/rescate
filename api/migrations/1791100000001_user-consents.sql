-- Up Migration
-- Feedback E2: consentimiento para tratar el correo de la cuenta (Ley 21.719).
-- Es una tabla y no una columna de users porque se otorga sobre una versión del
-- texto, se puede revocar y tiene que quedar el historial para demostrarlo.
CREATE TYPE public.consent_purpose AS ENUM ('account_email');
CREATE TABLE public.user_consents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id),
  purpose public.consent_purpose NOT NULL,
  policy_version text NOT NULL,
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT user_consents_policy_version_check CHECK (btrim(policy_version) <> ''),
  CONSTRAINT user_consents_revoked_at_check CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
-- Un solo consentimiento vigente por persona y propósito; los revocados quedan como historial.
CREATE UNIQUE INDEX user_consents_active_key ON public.user_consents (user_id, purpose)
  WHERE revoked_at IS NULL;

-- Down Migration
DROP TABLE public.user_consents;
DROP TYPE public.consent_purpose;
