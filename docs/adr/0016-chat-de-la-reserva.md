# ADR 0016 · chat de la reserva sin tabla de conversación y retención que borra el texto

Estado adoptada en K037.

## Contexto

Los anexos de E1 piden que cada reserva tenga como máximo una conversación, que se materialice
con el primer mensaje y que cada mensaje guarde autor, secuencia y clave de envío (B p. 4). El
envío consulta las reglas de asignación bajo el bloqueo del lote (C p. 5). El chat se elimina
treinta días después del cierre, pero el resultado idempotente guarda identificador y estado sin
copiar el texto, y las claves se conservan durante todo el piloto (H p. 21).

## Decisión

- **Sin tabla de conversación.** La conversación es el conjunto de mensajes de una reserva en
  `chat_messages`. Aparece sola con el primer mensaje y su estado se deriva de la reserva y del
  lote, igual que el vencimiento de una reserva confirmada.
- **Cierre derivado.** La conversación cierra en el menor instante entre `commitments.ended_at`,
  `lots.pickup_ends_at` y `lots.closed_at`. Ese mismo cálculo decide si se puede escribir y
  cuándo vence la retención, en Domain y en el SQL del borrado.
- **Secuencia bajo el bloqueo.** La siguiente secuencia se calcula con el lote bloqueado, y la
  unicidad por reserva y secuencia la respalda.
- **Un aviso por destinatario.** Cada mensaje avisa a la otra parte con `message_from_holder` o
  `message_from_establishment`, y como un mensaje del titular le llega a todos los operadores, la
  unicidad de `outbox_events_subject_key` pasa a incluir al destinatario. Conserva el nombre, así
  que el resto del outbox de [ADR 0012](0012-avisos-y-outbox.md) no cambia. El aviso no copia el texto.
- **Retención que borra el texto.** El worker deja `body` en NULL una vez al día. La fila queda
  como resultado del envío, con identificador, secuencia y clave, así que un reintento sigue
  devolviendo lo mismo y nunca crea otro mensaje. La respuesta del envío no repite el texto.

## Alternativas descartadas

- **Tabla `conversations`.** Solo guardaría la reserva y un contador de secuencia, que ya se
  obtiene bajo el bloqueo del lote. Sumaba una fila más que crear, bloquear y borrar.
- **Guardar el estado abierto o cerrado.** Habría que actualizarlo en cancelar, retirar, vencer
  y cerrar el lote, y un worker detenido lo dejaría desfasado.
- **Borrar las filas.** Perdería el resultado idempotente que H p. 21 pide conservar.
- **Un solo tipo de aviso de mensaje.** La bandeja no sabría si llevar al detalle del titular o al
  panel del operador sin agregar un campo nuevo al aviso.
- **Usar la versión del evento para distinguir destinatarios.** Funciona, pero la versión deja de
  significar una transición y confunde a quien lea el outbox.
- **Clave en una tabla aparte de operaciones.** Duplica identificador y estado del mensaje sin
  ganar nada mientras la fila sin texto ya cumple ese papel.
