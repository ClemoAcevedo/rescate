-- Up Migration
-- K032: compromisos de un lote en cualquier estado. El cuadre del inventario (lotReconciledSql)
-- suma las entregas uniendo commitments por lote, y commitments_lot_confirmed_idx solo cubre
-- las confirmadas: sin este índice cada reserva, cancelación y comando de la cola recorría la
-- tabla completa bajo el bloqueo del lote, con un costo que crece con la historia.
CREATE INDEX commitments_lot_idx ON public.commitments (lot_id);

-- Down Migration
DROP INDEX public.commitments_lot_idx;
