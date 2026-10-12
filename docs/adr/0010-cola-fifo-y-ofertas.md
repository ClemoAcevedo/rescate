# ADR 0010: cola FIFO y ofertas en una tabla propia

Estado: adoptada para K027. Concreta RF07 (anexos A p. 2, B p. 4, H p. 20) sobre
[ADR 0002](0002-ofertas-parciales.md) y el bloqueo común de
[ADR 0006](0006-inventario-del-lote.md).

## Decisión

**Tabla propia.** La solicitud, su oferta y su desenlace viven en `waitlist_entries`
(`waiting`, `offered`, `accepted`, `declined`, `expired`, `left`). Aceptar crea una fila
de `commitments` confirmada por la cantidad ofrecida y la enlaza; `commitments` conserva
su ciclo de reserva (K022). El orden FIFO es el `id` de la solicitud, asignado bajo el
bloqueo del lote. Los CHECK impiden una oferta mayor a lo pedido, una solicitud abierta
con `ended_at` o una aceptada sin reserva; un índice único parcial deja una solicitud
abierta por usuario y lote. La exclusión con la reserva confirmada cruza dos tablas y se
comprueba bajo el bloqueo (RF04).

**Asentar la cola bajo el bloqueo.** Toda transacción que libera packs o lee el
inventario del lote llama a `settleQueue` con el reloj de la base: registra las ofertas
cuya hora pasó, cierra la espera si el lote dejó de asignar y ofrece lo libre en orden
(`planOffers`, en Domain). Así la cola se mantiene consistente aunque el trabajador esté
detenido, y el trabajador de K028/K031 solo llama al mismo caso de uso (`settleDue`).

| Evento | Movimiento |
| --- | --- |
| Ofrecer | F → O |
| Aceptar | O → R y reserva confirmada |
| Rechazar o vencer la oferta | O → F, u O → X si el lote ya no asigna |
| Salir o terminar la espera | Ninguno: no posee packs |

**Rechazos que confirman.** Aceptar, rechazar y salir devuelven su rechazo como
resultado en vez de lanzarlo dentro de la transacción; si lanzaran, el rollback
descartaría el vencimiento que acababan de registrar.

## Alternativas descartadas

- **Ampliar `commitments.status` con espera y oferta.** Mezcla una demanda sin packs con
  una reserva con código y obliga a relajar `commitments_active_user_lot_key` y el CHECK
  del código. ADR 0002 distingue la solicitud en cola de la reserva confirmada.
- **Ofrecer solo desde el trabajador.** Deja packs libres con gente esperando mientras el
  trabajador no corra y contradice que la API no dependa de él para ser correcta.
- **Derivar O de las ofertas vigentes.** Igual que en ADR 0006, el contador explícito
  hace visible el movimiento y los CHECK rechazan la sobreasignación.

## Consecuencias

Ofrecer a quienes siguen ocurre dentro de la transacción de quien libera, de modo que un
cancelar o rechazar tarda lo que tarde la cola afectada (una lectura y una escritura por
solicitud ofrecida). La reconciliación de O bloquea nuevas asignaciones del lote igual
que la de R y E. Los avisos de oferta (K030) y la pantalla (K029) usan el contrato HTTP
sin cambiar estas reglas.
