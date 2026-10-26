-- Up Migration
-- K036: último ciclo exitoso del worker (anexos H p. 22). Una sola fila: con varios
-- workers basta que uno avance. La salud de la API la lee para informar un worker detenido.
CREATE TABLE public.worker_heartbeat (
  id boolean PRIMARY KEY DEFAULT true CONSTRAINT worker_heartbeat_single_check CHECK (id),
  last_cycle_at timestamptz NOT NULL
);

-- Down Migration
DROP TABLE public.worker_heartbeat;
