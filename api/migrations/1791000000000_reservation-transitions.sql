-- Up Migration
-- K022: estados terminales de la reserva, código de retiro y entrega (RF05, RF06, RF08).
-- Una reserva confirmada termina una sola vez: cancelada, vencida o retirada.
ALTER TABLE public.commitments DROP CONSTRAINT commitments_status_check;
ALTER TABLE public.commitments
  ADD CONSTRAINT commitments_status_check
    CHECK (status IN ('confirmed', 'cancelled', 'expired', 'delivered')),
  ADD COLUMN ended_at timestamptz,
  ADD CONSTRAINT commitments_ended_at_check CHECK ((status = 'confirmed') = (ended_at IS NULL));

-- Código de retiro (anexos H p. 21): cifrado con una clave externa a la base y una
-- huella HMAC para buscarlo. La huella es única en toda la historia, así que un
-- código no se reutiliza. Un estado terminal borra el cifrado: el código ya no se
-- puede volver a mostrar y la huella solo sirve para informar por qué se rechaza.
ALTER TABLE public.commitments
  ADD COLUMN pickup_code_ciphertext bytea,
  ADD COLUMN pickup_code_fingerprint bytea,
  ADD CONSTRAINT commitments_pickup_code_fingerprint_key UNIQUE (pickup_code_fingerprint),
  ADD CONSTRAINT commitments_pickup_code_check CHECK (
    (pickup_code_ciphertext IS NULL OR pickup_code_fingerprint IS NOT NULL)
    AND (status = 'confirmed' OR pickup_code_ciphertext IS NULL));

-- La entrega es un hecho histórico (modelo inicial): una por reserva, con el
-- operador que la acreditó y su clave de intención. Respalda el contador E.
CREATE TABLE public.deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  commitment_id bigint NOT NULL REFERENCES public.commitments(id),
  operator_user_id bigint NOT NULL REFERENCES public.users(id),
  quantity integer NOT NULL,
  delivered_at timestamptz NOT NULL,
  idempotency_key uuid NOT NULL,
  CONSTRAINT deliveries_quantity_check CHECK (quantity > 0),
  CONSTRAINT deliveries_commitment_key UNIQUE (commitment_id),
  CONSTRAINT deliveries_operator_idempotency_key UNIQUE (operator_user_id, idempotency_key)
);

-- Down Migration
DROP TABLE public.deliveries;
ALTER TABLE public.commitments
  DROP CONSTRAINT commitments_pickup_code_check,
  DROP CONSTRAINT commitments_pickup_code_fingerprint_key,
  DROP COLUMN pickup_code_fingerprint,
  DROP COLUMN pickup_code_ciphertext,
  DROP CONSTRAINT commitments_ended_at_check,
  DROP COLUMN ended_at,
  DROP CONSTRAINT commitments_status_check;
-- Volver atrás exige que solo queden reservas confirmadas.
ALTER TABLE public.commitments
  ADD CONSTRAINT commitments_status_check CHECK (status IN ('confirmed'));
