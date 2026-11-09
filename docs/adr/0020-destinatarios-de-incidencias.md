# ADR 0020: fijar los destinatarios de una incidencia por versión

Estado: adoptada en K043. Complementa ADR 0006 y 0012.

## Decisión

Cada versión publicada de una incidencia inserta sus destinatarios en
`incident_recipients`, en la transacción que crea la versión y bajo el bloqueo del lote.
La clave primaria `(incident_id, version, user_id)` es la garantía contra duplicados que
exige el anexo I p. 26. Los comandos que crean un compromiso toman el mismo bloqueo e
incorporan a su titular a la última versión de cada incidencia vigente, de modo que
publicar y reservar no pueden omitir a nadie, gane quien gane.

La tabla es el conjunto fijado y no la bandeja. Generar los avisos por tandas desde esas
filas queda en K044, sobre el outbox de ADR 0012. Publicar no llama a servicios externos.

La fila guarda el vínculo de la persona con el lote al momento de fijarla (`received`,
`committed` u `operator`), porque el texto distingue a quien recibió packs y ese hecho
puede cambiar después de publicar. Una versión nueva lo recalcula.

Los destinatarios de versiones previas se conservan en las siguientes, aunque hayan dejado
de ser operadores: el anexo pide avisar a destinatarios históricos y actuales.

Reportar no toma el bloqueo del lote: no cambia inventario ni destinatarios y así no
compite con las reservas. Solo serializa la intención de la persona.

## Alternativas descartadas

- **Calcular los destinatarios al generar cada aviso.** Una reserva o un cambio de
  membresía posteriores alterarían el conjunto de una versión ya publicada.
- **Insertar directamente un evento de outbox por persona.** Mezcla el registro de quién
  corresponde avisar con su entrega, y la unicidad de `outbox_events` no representa la
  versión de una incidencia sin ampliar `appendEvent`.
- **Incorporar con un trigger sobre `commitments`.** Ocultaría una regla de negocio en SQL
  y no cubriría `waitlist_entries` sin duplicarla.
