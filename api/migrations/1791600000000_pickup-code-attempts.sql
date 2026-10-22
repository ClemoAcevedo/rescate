-- Up Migration
-- K034: intentos de código de retiro por operador (anexos H p. 21, ADR 0013). Cinco códigos
-- inválidos en quince minutos suspenden revisar y confirmar durante quince minutos. Los
-- fallos viven aquí para que reiniciar la API no borre la suspensión. No se guarda el
-- código intentado, su huella ni el lote: basta el operador y el instante.
CREATE TABLE public.pickup_code_security_state (
  user_id bigint PRIMARY KEY REFERENCES public.users(id),
  blocked_until timestamptz,
  CONSTRAINT pickup_code_security_state_blocked_until_check CHECK (
    blocked_until IS NULL OR isfinite(blocked_until)
  )
);

CREATE TABLE public.pickup_code_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.pickup_code_security_state(user_id),
  failed_at timestamptz NOT NULL,
  CONSTRAINT pickup_code_failures_failed_at_check CHECK (isfinite(failed_at))
);

-- Consulta y limpieza de los fallos de un operador dentro de la ventana móvil.
CREATE INDEX pickup_code_failures_user_time_idx ON public.pickup_code_failures (user_id, failed_at);

-- Down Migration
DROP TABLE public.pickup_code_failures;
DROP TABLE public.pickup_code_security_state;
