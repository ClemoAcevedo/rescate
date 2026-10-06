-- Up Migration
-- K021: inventario del lote (anexos B p. 4). Q = F + O + R + E + X con contadores
-- no negativos: O, R, E y X se mueven bajo el bloqueo del lote y F se deriva, de
-- modo que la suma no puede romperse y ningún movimiento deja stock negativo.
ALTER TABLE public.lots
  ADD COLUMN offered_quantity integer NOT NULL DEFAULT 0,
  ADD COLUMN reserved_quantity integer NOT NULL DEFAULT 0,
  ADD COLUMN delivered_quantity integer NOT NULL DEFAULT 0,
  ADD COLUMN expired_quantity integer NOT NULL DEFAULT 0;

-- Las reservas confirmadas existentes ya ocupan R.
UPDATE public.lots l SET reserved_quantity = c.total
FROM (SELECT lot_id, sum(quantity)::integer AS total FROM public.commitments
      WHERE status = 'confirmed' GROUP BY lot_id) c
WHERE c.lot_id = l.id;

ALTER TABLE public.lots
  ADD COLUMN free_quantity integer GENERATED ALWAYS AS
    (quantity - offered_quantity - reserved_quantity - delivered_quantity - expired_quantity) STORED,
  ADD CONSTRAINT lots_inventory_counters_check CHECK (
    offered_quantity >= 0 AND reserved_quantity >= 0 AND delivered_quantity >= 0 AND expired_quantity >= 0),
  ADD CONSTRAINT lots_inventory_total_check CHECK (
    offered_quantity + reserved_quantity + delivered_quantity + expired_quantity <= quantity);

-- Down Migration
ALTER TABLE public.lots
  DROP CONSTRAINT lots_inventory_total_check,
  DROP CONSTRAINT lots_inventory_counters_check,
  DROP COLUMN free_quantity,
  DROP COLUMN expired_quantity,
  DROP COLUMN delivered_quantity,
  DROP COLUMN reserved_quantity,
  DROP COLUMN offered_quantity;
