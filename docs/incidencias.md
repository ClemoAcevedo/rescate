# Incidencias (RF11)

Una incidencia registra un problema descubierto sobre un lote, antes o después de entregar,
y lo comunica a quienes estuvieron vinculados con ese lote. El contrato HTTP está en
[OpenAPI](api/openapi.yaml) (etiqueta `Incidents`), los recorridos en
[casos de uso](casos-de-uso.md#cu-rf11-01--reportar-incidencia-de-un-lote) y las decisiones en
[ADR 0020](adr/0020-destinatarios-de-incidencias.md).

## Estados y permisos

| Acción | Quién | Estado | Efecto |
| --- | --- | --- | --- |
| Reportar | Quien tiene o tuvo un compromiso con el lote, incluida la espera, u operador miembro | `reported`, versión 0 | Solo guarda autor, motivo y fecha |
| Publicar | Operador miembro | `reported` → `open`, versión 1 | Fija motivo, instrucciones y destinatarios |
| Actualizar | Operador miembro | `open` o `following` → `following` | Nueva versión con destinatarios |
| Resolver | Operador miembro | `open` o `following` → `resolved` | Nueva versión con destinatarios; es terminal |

Un reporte solo guarda el problema. Publicar, actualizar y resolver fijan la versión y el
trabajo durable de aviso. Se admiten con el lote cerrado. El inventario, los compromisos y los
códigos solo cambian si el comando incluye la decisión explícita `closeLot: true`. Una persona sin acceso
recibe 404 al reportar, igual que con un lote inexistente; una incidencia ajena también
responde 404. La administración no opera incidencias porque ese rol aún no existe en la API.

Cada comando lleva un UUID de intención por persona. La misma clave con iguales parámetros
reproduce el resultado original, aunque la incidencia haya avanzado; con otros parámetros
responde 409. Crear una versión exige además la versión vigente.

## Destinatarios

`incident_recipients` guarda una fila por incidencia, versión y persona, con la clave primaria
como garantía contra duplicados. Al crear una versión, bajo el bloqueo del lote, se fijan:

- quienes tienen o tuvieron un compromiso: en espera, con oferta, con reserva activa, cancelados,
  vencidos, retirados o que salieron de la cola;
- los operadores actuales del establecimiento;
- los destinatarios de versiones anteriores, aunque ya no sean operadores.

`relation` conserva el vínculo más fuerte: `received` si retiró packs, `committed` si solo tuvo un
compromiso y `operator` en otro caso. El texto del aviso usa ese dato para distinguir a quien
recibió packs.

Reservar directamente o entrar a la cola incorpora a la persona a la última versión de cada
incidencia `open` o `following` del lote, en la misma transacción y bajo el mismo bloqueo que
publicar. Aceptar una oferta no incorpora a nadie: su titular ya estaba en la cola. Una
incidencia resuelta no incorpora a nadie.

## Cierre explícito

`POST /incidents/{incidentId}/versions` admite `closeLot`, falso por defecto. Cerrar y crear
la versión usan la misma transacción y el bloqueo común del lote. El cierre cancela reservas
pendientes, borra sus códigos legibles, termina ofertas y espera, mueve F/O/R a X y conserva
las entregas E, sus personas, cantidades y fechas. También limpia una pausa y aumenta la
versión del lote, para que un editor anterior no pueda modificarlo como si siguiera abierto.
Los avisos de esa incidencia reemplazan los avisos individuales de cancelación y vencimiento.

Cierre y entrega compiten por el mismo bloqueo: si entrega confirma primero, se conserva y
el destinatario figura como `received`; si cierra primero, el código ya no permite entregar.
Una discrepancia de inventario impide cerrar hasta revisarla. Un borrador no admite cierre.
Si ya terminó la ventana, se registra `expired` con su hora original; un cierre anterior se
conserva. Resolver no reabre ni rehabilita códigos. Reintentar la misma clave devuelve el
resultado original; cambiar la decisión de cierre con esa clave es un conflicto.

`closeLot` y `lotClosed` en la respuesta e historial conservan, respectivamente, la decisión
del comando y si el lote estaba cerrado al publicar esa versión.

## Avisos recuperables

La versión y cada fila de `incident_recipients` son el trabajo durable confirmado con la
publicación. El worker toma hasta 50 destinatarios pendientes con `FOR UPDATE SKIP LOCKED`,
inserta sus eventos y los enlaza con `outbox_event_id` en una transacción corta, sin bloquear
el lote. Si falla o muere antes del commit, la tanda sigue pendiente. Dos workers pueden
avanzar sobre tandas distintas. Una reserva posterior agrega otro pendiente de la versión
vigente, aunque la primera tanda ya se haya enviado.

El evento `incident_version` es único por incidencia, versión y persona. Conserva motivo,
instrucciones, vínculo y estado de cierre de la versión comunicada. El [outbox](avisos.md)
genera un aviso persistente por evento y destinatario, con concesión y reintentos; tras cinco
fallos queda visible para Operación. Desconectarse no elimina el aviso ni lo marca leído.
`ops:status` incluye tanto destinatarios aún sin evento como eventos pendientes o fallidos.

La bandeja existente admite estos avisos, muestra instrucciones y distingue a quien recibió
packs de quien solo tuvo un compromiso. La lectura se limita al destinatario y conserva el
primer instante; no modifica el lote ni acredita haber seguido las instrucciones. La vista
específica de historial del destinatario y la gestión del operador siguen en
[K045](https://github.com/ClemoAcevedo/rescate/issues/47) y
[K046](https://github.com/ClemoAcevedo/rescate/issues/48); la regresión de seguimiento está en
[K047](https://github.com/ClemoAcevedo/rescate/issues/51).

## Pruebas

| Comando | Qué comprueba |
| --- | --- |
| `npm --prefix api test` | Transiciones, límites de texto, autorización antes y dentro del bloqueo, versión e idempotencia. |
| `npm --prefix api run db:test:incidents:compose` | PostgreSQL real y contrato HTTP: permisos, reporte sin efectos, versiones, todos los estados de compromiso, deduplicación, incorporación posterior, carrera con reservas observando el bloqueo, reintentos concurrentes, lote cerrado y reversión ante fallos. |
| `npm --prefix api run db:test:incident-delivery:compose` | Cierre con F/O/R/E, ambas carreras con bloqueos observados, reversión tras cerrar, plazos, incorporación posterior, dos dispatchers, cien avisos y worker real matado/reiniciado, múltiples versiones, fallos, reintentos y lectura propia. |
| `npm --prefix api run test:web:notifications` | API y worker reales por HTTPS: cierre explícito, recuperación al reconectar, instrucciones largas a 360/1366 px, lectura, privacidad y resolución sin reapertura. |
