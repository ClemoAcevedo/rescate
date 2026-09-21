-- Up Migration
-- K008, etapa 1B: solo persistencia. node-pg-migrate ejecuta la migración
-- transaccionalmente. No normalizar, fusionar ni eliminar usuarios existentes.
LOCK TABLE public.users IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.users) THEN
    RAISE EXCEPTION 'K008 requiere users vacío; no se modificaron los usuarios existentes.'
      USING HINT = 'Revisar la base objetivo antes de aplicar K008. No borrar ni fusionar cuentas automáticamente.';
  END IF;
END
$$;

-- Una sola autoridad para el futuro port de Application y el CHECK.
-- ICU raíz: minúsculas Unicode sin reglas turcas/lituanas ni locale del host.
CREATE COLLATION public.rescate_email_unicode (provider = icu, locale = 'und', deterministic = true);
CREATE FUNCTION public.canonicalize_email(input text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN pg_catalog.lower(pg_catalog.btrim(input,
  U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
) COLLATE public.rescate_email_unicode);

-- Trim exterior explícito (WhiteSpace + LineTerminator de ECMAScript),
-- sin quitar espacios interiores, puntos, sufijos + ni normalizar NFC/NFKC.
-- C garantiza igualdad exacta del resultado canónico, también para UNIQUE.
ALTER TABLE public.users ALTER COLUMN email TYPE text COLLATE "C";
ALTER TABLE public.users
  ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD CONSTRAINT users_public_id_key UNIQUE (public_id),
  ADD CONSTRAINT users_email_canonical_check CHECK (
    email <> '' AND email = public.canonicalize_email(email)
  );

CREATE TABLE public.user_credentials (
  user_id bigint PRIMARY KEY REFERENCES public.users(id),
  password_hash bytea NOT NULL,
  password_salt bytea NOT NULL,
  scrypt_n integer NOT NULL,
  scrypt_r integer NOT NULL,
  scrypt_p integer NOT NULL,
  CONSTRAINT user_credentials_hash_length_check CHECK (octet_length(password_hash) = 64),
  CONSTRAINT user_credentials_salt_length_check CHECK (octet_length(password_salt) = 16),
  -- Validez estructural, no perfil de seguridad ni default de costo.
  -- El adaptador de etapa 2 validará perfiles y límites de recursos.
  CONSTRAINT user_credentials_scrypt_n_check CHECK (scrypt_n > 1 AND (scrypt_n & (scrypt_n - 1)) = 0),
  CONSTRAINT user_credentials_scrypt_r_check CHECK (scrypt_r > 0),
  CONSTRAINT user_credentials_scrypt_p_check CHECK (scrypt_p > 0)
);

CREATE TABLE public.sessions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id),
  token_hash bytea NOT NULL CONSTRAINT sessions_token_hash_key UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT sessions_token_hash_length_check CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_lifetime_check CHECK (
    isfinite(created_at) AND isfinite(expires_at)
    AND expires_at = created_at + interval '12 hours'
  ),
  CONSTRAINT sessions_revocation_check CHECK (
    revoked_at IS NULL OR (isfinite(revoked_at) AND revoked_at >= created_at)
  )
);

-- La fila por cuenta permite serializar la decisión después de verificar
-- scrypt fuera de la transacción. Esta migración no implementa ese protocolo.
CREATE TABLE public.login_security_state (
  user_id bigint PRIMARY KEY REFERENCES public.users(id),
  blocked_until timestamptz,
  CONSTRAINT login_security_state_blocked_until_check CHECK (
    blocked_until IS NULL OR isfinite(blocked_until)
  )
);

CREATE TABLE public.login_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.login_security_state(user_id),
  failed_at timestamptz NOT NULL,
  CONSTRAINT login_failures_failed_at_check CHECK (isfinite(failed_at))
);

-- Consulta y limpieza de los fallos de una cuenta dentro de la ventana móvil.
CREATE INDEX login_failures_user_time_idx ON public.login_failures (user_id, failed_at);

-- Down Migration
-- Solo en bases dedicadas: pierde credenciales, sesiones, bloqueos e IDs
-- públicos de usuario. Conserva users, memberships y todos los datos K010.
DROP TABLE public.login_failures;
DROP TABLE public.login_security_state;
DROP TABLE public.sessions;
DROP TABLE public.user_credentials;
ALTER TABLE public.users
  DROP CONSTRAINT users_email_canonical_check,
  DROP CONSTRAINT users_public_id_key,
  DROP COLUMN public_id;
ALTER TABLE public.users ALTER COLUMN email TYPE text COLLATE "default";
DROP FUNCTION public.canonicalize_email(text);
DROP COLLATION public.rescate_email_unicode;
