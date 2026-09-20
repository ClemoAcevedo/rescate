-- Up Migration
-- K003: alcance y fuentes por atributo en docs/modelo-inicial.md.

CREATE TABLE public.users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL CONSTRAINT users_email_key UNIQUE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_email_check CHECK (btrim(email) <> '')
);

CREATE TABLE public.establishments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  address text NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  time_zone text NOT NULL,
  CONSTRAINT establishments_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT establishments_address_check CHECK (btrim(address) <> ''),
  CONSTRAINT establishments_latitude_check CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT establishments_longitude_check CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT establishments_time_zone_check CHECK (btrim(time_zone) <> '')
);

CREATE TABLE public.memberships (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id),
  establishment_id bigint NOT NULL REFERENCES public.establishments(id),
  CONSTRAINT memberships_user_establishment_key UNIQUE (user_id, establishment_id)
);

CREATE TABLE public.lots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  establishment_id bigint NOT NULL REFERENCES public.establishments(id),
  description text NOT NULL,
  category text NOT NULL,
  quantity integer NOT NULL,
  conditions text,
  address text NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  time_zone text NOT NULL,
  pickup_starts_at timestamptz NOT NULL,
  pickup_ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at timestamptz,
  CONSTRAINT lots_description_check CHECK (btrim(description) <> '' AND char_length(description) <= 2000),
  CONSTRAINT lots_category_check CHECK (btrim(category) <> ''),
  CONSTRAINT lots_quantity_check CHECK (quantity > 0),
  CONSTRAINT lots_address_check CHECK (btrim(address) <> ''),
  CONSTRAINT lots_latitude_check CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT lots_longitude_check CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT lots_time_zone_check CHECK (btrim(time_zone) <> ''),
  CONSTRAINT lots_pickup_window_check CHECK (pickup_ends_at > pickup_starts_at),
  CONSTRAINT lots_status_check CHECK (status IN ('draft', 'published')),
  CONSTRAINT lots_publication_check CHECK (
    (status = 'draft' AND published_at IS NULL) OR
    (status = 'published' AND published_at IS NOT NULL)
  )
);

CREATE TABLE public.commitments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id),
  lot_id bigint NOT NULL REFERENCES public.lots(id),
  quantity integer NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT commitments_quantity_check CHECK (quantity > 0),
  CONSTRAINT commitments_status_check CHECK (status IN ('confirmed'))
);

-- RF04: un compromiso activo por usuario/lote. Ampliar el predicado junto
-- con los estados activos de espera/oferta cuando se implementen esas tarjetas.
CREATE UNIQUE INDEX commitments_active_user_lot_key
  ON public.commitments (user_id, lot_id) WHERE status = 'confirmed';

-- Down Migration
-- Solo K003, sin CASCADE ni cambios en la tabla técnica/historial de K002.
DROP TABLE public.commitments;
DROP TABLE public.lots;
DROP TABLE public.memberships;
DROP TABLE public.establishments;
DROP TABLE public.users;
