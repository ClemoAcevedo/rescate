-- Up Migration
-- K015: índice sobre las coordenadas existentes; no duplica su fuente de verdad.
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;
CREATE INDEX lots_public_location_idx ON public.lots USING gist
  ((ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography))
  WHERE status = 'published';

-- Down Migration
DROP INDEX public.lots_public_location_idx;
-- PostGIS puede pertenecer al entorno y a otros consumidores. No se elimina.
