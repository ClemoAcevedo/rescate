# ADR 0012: avisos internos con outbox transaccional

Estado: adoptada para K030. Concreta RF09 (anexos A p. 2, B, H p. 20 e I p. 27) sobre el
bloqueo común de [ADR 0006](0006-inventario-del-lote.md) y la cola de
[ADR 0010](0010-cola-fifo-y-ofertas.md). El funcionamiento está en [avisos](../avisos.md).

## Decisión

**El evento nace con la transición.** Cancelar una reserva, emitir una oferta, registrar su
vencimiento y aceptarla insertan una fila en `outbox_events` con el mismo cliente de su
transacción. Si la transición se revierte, el evento también; si se confirma, el aviso se
generará aunque la API caiga justo después. La inserción vive junto a la escritura que ya
hace cada repositorio (`settleQueue`, aceptar y cancelar), sin cambiar sus reglas. La unicidad
por tipo, fila y versión impide registrar dos veces la misma transición.

**El worker genera los avisos.** Reclama tandas de hasta 50 eventos con `FOR UPDATE SKIP LOCKED`
y un reclamo de dos minutos, confirmado antes de procesar. Por cada evento inserta el aviso y
marca el evento procesado en una transacción. La clave única (evento, destinatario) de
`notifications` garantiza un solo aviso aunque el worker caiga a mitad de la tanda y otro
proceso la retome al vencer el reclamo. Un fallo reintenta con espera creciente desde 2 s,
tope de 5 min y variación de ±20 %; tras cinco intentos queda `failed`, visible para revisión.

**Leer no actúa.** La bandeja registra la lectura (la primera se conserva) y enlaza al detalle
de la solicitud o la reserva, que vuelve a comprobar permisos y estado vigente. Un aviso antiguo
nunca confirma ni reactiva nada. El aviso no guarda códigos de retiro.

**Una tarea más del worker.** Los avisos se suman al ciclo de vencimientos y fotos de
[ADR 0011](0011-vencimientos-con-concesion.md): una tanda por vuelta, solo con la base. Un
vencimiento de oferta registrado por ese trabajador pasa por `settleQueue` y genera su aviso
en la misma transacción, sin coordinación adicional.

## Alternativas descartadas

- **Escribir el aviso directamente en la transición, sin outbox.** Bastaría para un destinatario,
  pero E1 pide eventos con versión y tandas recuperables para avisos con muchos destinatarios
  (incidencias, RF11), y mezclaría la fan-out con el bloqueo del lote.
- **`LISTEN/NOTIFY` de PostgreSQL.** No persiste: un worker detenido pierde la notificación, y
  E1 exige que el aviso sobreviva a reinicios.
- **Cola externa (Redis, broker).** Agrega infraestructura y una escritura fuera de la
  transacción; ADR 0003 descarta brokers sin necesidad demostrada.
- **Generar el aviso al leer la bandeja.** Haría que leer escriba y que el aviso dependa de que
  alguien consulte; generar y leer son estados distintos (anexos A p. 2).

## Consecuencias

Entre la transición y el aviso hay la latencia del worker (consulta cada 2 s sin trabajo); con
el worker detenido, los eventos esperan sin perderse. La bandeja consulta cada 15 s con la vista
visible y al reconectar, sin push ni WebSocket. Los avisos de incidencias (RF11) agregarán su
propio conjunto de destinatarios sobre el mismo outbox.

## Verificación

`db:test:notifications:compose` prueba atomicidad con la transición, unicidad tras reprocesar,
reclamo vencido, dos workers en paralelo, fallos visibles y que leer no reactiva una oferta
vencida; `test:web:notifications` recorre la bandeja con API y worker reales.
