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

Un reporte no cancela, no cierra el lote ni avisa. Publicar, actualizar y resolver no cambian
inventario, compromisos ni códigos, y se admiten con el lote cerrado. Una persona sin acceso
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

Convertir esas filas en avisos de la bandeja y cerrar el lote por incidencia corresponden a
[K044](https://github.com/ClemoAcevedo/rescate/issues/49); la lectura por destinatario a
[K045](https://github.com/ClemoAcevedo/rescate/issues/47) y la gestión del operador a
[K046](https://github.com/ClemoAcevedo/rescate/issues/48).

## Pruebas

| Comando | Qué comprueba |
| --- | --- |
| `npm --prefix api test` | Transiciones, límites de texto, autorización antes y dentro del bloqueo, versión e idempotencia. |
| `npm --prefix api run db:test:incidents:compose` | PostgreSQL real y contrato HTTP: permisos, reporte sin efectos, versiones, todos los estados de compromiso, deduplicación, incorporación posterior, carrera con reservas observando el bloqueo, reintentos concurrentes, lote cerrado y reversión ante fallos. |
