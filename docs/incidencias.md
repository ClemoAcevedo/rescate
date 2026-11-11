# Incidencias (RF11)

Una incidencia registra un problema descubierto sobre un lote, antes o después de entregar,
y lo comunica a quienes estuvieron vinculados con ese lote. El contrato HTTP está en
[OpenAPI](api/openapi.yaml) (etiqueta `Incidents`), los recorridos en
[casos de uso](casos-de-uso.md#cu-rf11-01--reportar-incidencia-de-un-lote) y las decisiones en
[ADR 0020](adr/0020-destinatarios-de-incidencias.md) y
[ADR 0021](adr/0021-gestion-de-incidencias-del-operador.md).

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
el lote. Si falla o muere antes del commit, la tanda sigue pendiente. Si muere mientras
genera avisos, los ya confirmados se conservan y los eventos que había reclamado esperan la
concesión de 120 s del outbox; el worker reiniciado sigue antes con los que no tenían evento.
Dos workers pueden avanzar sobre tandas distintas. Una reserva posterior agrega otro
pendiente de la versión vigente, aunque la primera tanda ya se haya enviado.

El evento `incident_version` es único por incidencia, versión y persona. Conserva motivo,
instrucciones, vínculo y estado de cierre de la versión comunicada. El [outbox](avisos.md)
genera un aviso persistente por evento y destinatario, con concesión y reintentos; tras cinco
fallos queda visible para Operación. Desconectarse no elimina el aviso ni lo marca leído.
`ops:status` incluye tanto destinatarios aún sin evento como eventos pendientes o fallidos.

## Historial y lectura del destinatario

`/incidencias` lista las versiones publicadas para la persona de la sesión, incluidas las
leídas. Se accede desde la bandeja, el historial y el detalle de reservas. Cada aviso abre
`/incidencias/:notificationId`: el identificador corresponde a un aviso propio, no al caso
general ni al destinatario de otra persona. Cada versión conserva su motivo, instrucciones,
estado, vínculo y situación de cierre. Una actualización o resolución agrega otro aviso;
no reescribe las instrucciones de las versiones anteriores.

El detalle distingue quien recibió packs, quien tuvo un compromiso sin entrega registrada
y quien recibe como operador, según el vínculo fijado al publicar. Muestra que el estado
pertenece a esa versión y puede diferir del actual. Las instrucciones se consultan aunque
el lote esté cerrado, la reserva haya terminado o el texto del chat se haya borrado por
retención; su lectura no consulta esos recursos ni exige una reserva activa.

La bandeja conserva las instrucciones en la propia tarjeta y ofrece «Ver incidencia».
«Marcar como leído», tanto en bandeja como en detalle, confirma el registro persistido de
la primera lectura; una respuesta perdida permite reintentar. El texto diferencia lectura
de cumplimiento de instrucciones. Leer no modifica el caso, el lote ni las entregas.
Cada persona solo consulta y marca sus propios avisos: uno ajeno responde el mismo 404 que
uno inexistente, sin identidades de otros destinatarios.

Historial, detalle y bandeja consultan cada 15 segundos con la pestaña visible y recuperan
los avisos al reconectar. El filtro de incidencias pagina en el servidor y conserva el
contador global de avisos sin leer. Las instrucciones siguen siendo accesibles desde el
historial después de registrar lectura. El detalle agrupa vínculo y cierre en un resumen;
motivo e instrucciones ocupan su altura natural. El skeleton conserva el ancho y la
disposición de las regiones, y los datos visibles mantienen su geometría al refrescar.

## Gestión del operador

`GET /establishments/{establishmentId}/incidents` lista las incidencias de todos los lotes
del establecimiento, del reporte más reciente al más antiguo, en páginas de 20 y filtrables
por estado, con el permiso del [panel](panel.md): otro establecimiento recibe 403. Cada
versión, también en el listado del lote, informa el correo del operador que la publicó,
aunque después deje de ser miembro, y sus avisos por destinatario: pendientes (sin aviso
todavía: en cola, reintentando o con un fallo que ve Operación), generados sin leer y
leídos. Los tres suman `recipientCount` y no identifican a nadie; la API tampoco informa
quién reportó.

«Mi establecimiento» muestra los reportes por revisar. `/operador/incidencias` lista todas las
incidencias con filtros por estado y lleva a `/operador/lotes/:lotId/incidencias`, que también se
abre desde «Mis lotes», el lote publicado y sus tarjetas del panel. Ahí el operador reporta un
problema, revisa cada reporte y publica, actualiza o resuelve con motivo e instrucciones. El
motivo parte del reporte o de la última versión. Cerrar el lote es una casilla aparte, solo con
el lote abierto, y pide confirmar antes de enviar. Cada versión muestra responsable, fecha,
motivo, instrucciones, decisión de cierre y avisos. Una respuesta perdida permite reintentar la
misma operación con su clave; una versión desactualizada pide actualizar. Resuelta, la
incidencia ya no ofrece acciones.

## Reporte de quien reservó

El detalle de una reserva y el de una solicitud de espera ofrecen «Reportar un problema con este
lote», que abre `/lotes/:id/reportar`. La página aclara que el establecimiento revisa el reporte
antes de avisar y que la reserva o la espera siguen igual. Una respuesta perdida reintenta el
mismo reporte; sin acceso al lote, la API responde 404 y la página lo explica.

## Recorrido manual

Con Docker Desktop activo, dependencias de API y web instaladas y Chromium de Playwright:

```bash
docker compose up -d --wait db
MANUAL_INCIDENTS=1 WEB_SCRIPTS=test:web:notifications npm --prefix api run test:web:compose
```

El comando prepara una base aislada, ejecuta el recorrido integrado y mantiene API, worker
y web HTTPS en marcha hasta escribir `salir` en la terminal. Imprime la URL de login en
`https://localhost:5174` y las credenciales de dos cuentas: una con entrega acreditada y otra
sin entrega. Acepta el certificado local de desarrollo y entra a `/incidencias` para abrir
las versiones, comprobar las instrucciones y registrar lectura. Las versiones que el
recorrido ya leyó conservan su registro; `aviso` publica una nueva versión pendiente.

La terminal también imprime la URL de un aviso propio de la cuenta con entrega. Abrirla
con la otra cuenta rechaza el acceso. Para comprobar reconexión, abre `/avisos` con la
cuenta con entrega, activa Offline en Network de DevTools, escribe `aviso` en la terminal
y vuelve a Online. Las versiones de esta demo se publican por los casos de uso reales de
K043/K044; las cuentas y lotes son ficticios y la base de desarrollo conserva sus datos.

## Pruebas

| Comando | Qué comprueba |
| --- | --- |
| `npm --prefix api test` | Transiciones, límites de texto, autorización antes y dentro del bloqueo, versión e idempotencia; listado por establecimiento con 404/403 y consulta estricta contra OpenAPI. |
| `npm --prefix api run db:test:incidents:compose` | PostgreSQL real y contrato HTTP: permisos, reporte sin efectos, versiones, todos los estados de compromiso, deduplicación, incorporación posterior, carrera con reservas observando el bloqueo, reintentos concurrentes, lote cerrado y reversión ante fallos. |
| `npm --prefix api run db:test:incident-delivery:compose` | Cierre con F/O/R/E, ambas carreras con bloqueos observados, reversión tras cerrar, plazos, incorporación posterior, dos dispatchers, cien avisos y worker real matado/reiniciado, múltiples versiones, fallos, reintentos y lectura propia. |
| `npm --prefix api run db:test:incident-followup:compose` | Seguimiento después de entregar con el worker real: cien destinatarios mixtos creados por los casos de uso, chats cerrados y con texto borrado por retención, worker matado con 30 de 100 avisos y reiniciado, versión que retiene el bloqueo mientras 10 reservas y 10 retiros lo esperan, y cierre; quien retiró después figura como `received` en la versión siguiente. Exige un aviso por versión y persona, en 30 s o menos con el worker sano, y conserva E y F+O+R+E+X. Tarda unos dos minutos por la concesión. |
| `npm --prefix api run test:web:notifications` | API y worker reales por HTTPS: cierre explícito, recuperación al reconectar, instrucciones largas a 360/1366 px, lectura, privacidad y resolución sin reapertura; historial y detalle de versiones propias, lectura persistida, instrucciones tras la retención del chat y destinatario con entrega acreditada. |
| `npm --prefix api run test:web:incidents` | HTTP controlado validado contra OpenAPI: error/reintento, vacío, reconexión, con/sin entrega, fallo al registrar lectura, contenido largo y aviso ajeno a 360/1366 px. |
| `npm --prefix api run db:test:incident-management:compose` | PostgreSQL real y contrato HTTP: listado por establecimiento con permisos y 422, reporte de quien reservó sin identificarlo, responsable de cada versión aun sin membresía, pendientes/generados/leídos tras el worker y la lectura, filtro por estado y páginas de 20 sin mezclar establecimientos. |
| `WEB_SCRIPTS=test:web:incident-management npm --prefix api run test:web:compose` | Invocación propia, con su cupo de login por IP. API y worker reales por HTTPS: reporte desde la reserva a 360 px sin cancelarla, reportes por revisar en «Mi establecimiento», publicación con responsable, avisos leídos, filtro por estado, cierre con confirmación, resolución terminal, acceso de otro establecimiento y 360 px sin desbordes ni 429. |
| `npm --prefix api run test:web:ux` | Geometría de las cargas de historial y detalle de incidencia, además de las demás vistas. |
