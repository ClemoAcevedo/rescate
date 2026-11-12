# Avisos internos (RF09)

Cada persona recibe en la web avisos de las transiciones de sus solicitudes y reservas. Los
avisos persisten aunque no esté conectada y se recuperan al volver. El contrato HTTP está en
[OpenAPI](api/openapi.yaml) (etiqueta `Notifications`) y las decisiones en
[ADR 0012](adr/0012-avisos-y-outbox.md).

## Qué genera un aviso

| Tipo | Transición | Destinatario | Enlace |
| --- | --- | --- | --- |
| `offer_issued` | Se emite una oferta a la cabeza de la [cola](cola-de-espera.md) | Titular de la solicitud | `/espera/:id` |
| `offer_expired` | Se registra el vencimiento de esa oferta | Titular de la solicitud | `/espera/:id` |
| `reservation_confirmed` | Se acepta la oferta y nace la reserva | Titular | `/reservas/:id` |
| `reservation_cancelled` | El titular cancela su [reserva](reservas.md) o el operador retira la publicación | Titular | `/reservas/:id` |
| `incident_version` | Publicar, actualizar o resolver una [incidencia](incidencias.md) | Destinatarios fijados de esa versión | `/incidencias/:notificationId` (instrucciones y lectura propia) |
| `message_from_holder` | El titular escribe en el [chat](chat.md) de la reserva | Cada operador del local | `/operador/panel` |
| `message_from_establishment` | Un operador escribe en el [chat](chat.md) de la reserva | Titular | `/reservas/:id` |

Reservar directamente, entrar a la cola, rechazar, salir y retirar no generan avisos. Una
oferta vencida se avisa cuando se registra: en el siguiente comando sobre el lote o cuando
el trabajador de [vencimientos](vencimientos.md) la registra, ambos a través de `settleQueue`.

## Reglas

- **Un aviso por evento y destinatario.** El evento se inserta en la misma transacción que la
  transición; el worker genera el aviso. Un mensaje del chat tiene un evento por cada destinatario. Reintentos, reinicios o dos workers no lo duplican.
- **Persistencia.** Generar y leer son estados distintos: el aviso existe aunque la persona
  estuviera desconectada y queda sin leer hasta que lo abre.
- **Leer no actúa.** Marcar como leído solo registra el instante (se conserva el primero). El
  enlace lleva al estado vigente: una oferta vencida sigue vencida y no se puede aceptar.
- **Privacidad.** Cada persona consulta solo sus avisos; uno ajeno responde 404 igual que uno
  inexistente. Los avisos no llevan códigos de retiro ni datos de otras personas. Los de mensaje tampoco llevan el texto.

## Contrato HTTP

| Método | Ruta | Resultado |
| --- | --- | --- |
| GET | `/notifications` | 200, avisos propios en páginas de 20, más recientes primero, con `unreadCount` |
| GET | `/notifications?kind=incident_version` | 200, historial paginado de versiones propias, leídas y sin leer; contador global |
| GET | `/notifications/:notificationId` | 200, aviso propio sin registrar lectura; 404 si es ajeno o no existe |
| POST | `/notifications/:notificationId/read` | 200, aviso con su lectura; cuerpo `{}` |

La lectura exige sesión, `Origin` y CSRF.

## Web

La cabecera muestra «Avisos» con el total sin leer. `/avisos` lista la bandeja con título y
texto según el tipo, el lote, la fecha y un indicador «Nuevo». Abrir un aviso lo marca como
leído y lleva a la solicitud o la reserva. Las incidencias muestran las instrucciones en
la tarjeta y permiten abrir un detalle propio o registrar lectura con confirmación y reintento.
`/incidencias` conserva todas las versiones propias, también las leídas; consultar el detalle
no registra lectura ni acredita cumplimiento de instrucciones. La bandeja y el contador consultan cada 15 s con la
pestaña visible, se pausan sin conexión y consultan de inmediato al volver a la pestaña o al
reconectar (anexos H p. 20).

## Outbox y worker

Para incidencias, el worker convierte primero hasta 50 destinatarios aún sin evento en
`outbox_events`, en una transacción corta que marca sus filas de origen. La versión forma
parte de la unicidad del evento: una actualización vuelve a avisar a cada persona. Un fallo
antes de confirmar deja los destinatarios pendientes; después, la concesión y los reintentos
del outbox recuperan el aviso. El cierre por incidencia usa estos avisos y conserva las
entregas previas. Los detalles están en [incidencias](incidencias.md).

`outbox_events` guarda tipo, fila, versión, destinatario, datos del aviso, estado
(`pending`, `processed`, `failed`), intentos, disponibilidad y reclamo. El worker:

1. Reclama hasta 50 eventos pendientes con `FOR UPDATE SKIP LOCKED` y un reclamo de 2 minutos.
2. Por cada evento inserta el aviso y marca el evento procesado en una transacción.
3. Ante un error reintenta con espera creciente (2 s al doble, tope 5 min, ±20 %); tras cinco
   intentos, o si un reclamo vencido ya los agotó, el evento queda `failed` con su código de error.

Es una tarea más del ciclo del worker, junto a [vencimientos](vencimientos.md) y
[fotos](fotos.md): una tanda por vuelta y, sin trabajo, espera 2 s. Necesita solo `DATABASE_URL`.

## Pruebas

Los casos de tandas, concesiones y workers simultáneos usan un reloj fijo compartido
con los eventos sintéticos. Comprueban la disponibilidad y el vencimiento justo
antes y en su límite, sin depender de diferencias entre la precisión de PostgreSQL
y la de JavaScript. La concurrencia conserva dos procesadores y PostgreSQL reales;
cada evento de esa prueba se reclama una sola vez.

La prueba de integración consulta el código de retiro real y comprueba que no aparezca
en los eventos. La descripción del lote termina en ocho dígitos para cubrir el falso
positivo de una búsqueda por patrón.

| Comando | Qué comprueba |
| --- | --- |
| `npm --prefix api test` | Espera creciente y fallo visible, tandas de 50, liberación de fallos y transporte HTTP contra OpenAPI. |
| `npm --prefix api run db:test:notifications:compose` | PostgreSQL real: evento confirmado con la transición y ausente si se revierte, un aviso por evento al reprocesar, aceptación, permisos, oferta vencida que leer no reactiva, persistencia tras cerrar sesión, reclamo vencido retomado, dos workers en paralelo con 100 eventos y evento `failed`. |
| `npm --prefix api run db:test:queue-worker:compose` | Flujo de [cola](cola-de-espera.md) con el worker muerto tras reclamar la tanda: al reiniciar, un aviso por evento en la sesión de cada persona. |
| `npm --prefix api run test:web:notifications` | Chromium con API y worker reales: contador por consulta periódica, recuperación al reconectar, bandeja, lectura que lleva a una oferta vencida sin aceptar y bandejas separadas. Corre dentro de `test:web:compose`. |

`test:web:notifications` también comprueba avisos de incidencia y su lectura sin navegar a
una reserva inexistente. Las tarjetas de incidencia agrupan versión y enlace, con párrafos de altura natural
y un pie para la lectura. Conservan el contenido visible al refrescar. Las instrucciones
se muestran en la propia tarjeta y en su
[detalle e historial](incidencias.md#historial-y-lectura-del-destinatario).
