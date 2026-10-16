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
| `reservation_cancelled` | El titular cancela su [reserva](reservas.md) | Titular | `/reservas/:id` |

Reservar directamente, entrar a la cola, rechazar, salir y retirar no generan avisos. Una
oferta vencida se avisa cuando se registra: en el siguiente comando sobre el lote o cuando
el trabajador de [vencimientos](vencimientos.md) la registra, ambos a través de `settleQueue`.

## Reglas

- **Un aviso por evento y destinatario.** El evento se inserta en la misma transacción que la
  transición; el worker genera el aviso. Reintentos, reinicios o dos workers no lo duplican.
- **Persistencia.** Generar y leer son estados distintos: el aviso existe aunque la persona
  estuviera desconectada y queda sin leer hasta que lo abre.
- **Leer no actúa.** Marcar como leído solo registra el instante (se conserva el primero). El
  enlace lleva al estado vigente: una oferta vencida sigue vencida y no se puede aceptar.
- **Privacidad.** Cada persona consulta solo sus avisos; uno ajeno responde 404 igual que uno
  inexistente. Los avisos no llevan códigos de retiro ni datos de otras personas.

## Contrato HTTP

| Método | Ruta | Resultado |
| --- | --- | --- |
| GET | `/notifications` | 200, avisos propios en páginas de 20, más recientes primero, con `unreadCount` |
| POST | `/notifications/:notificationId/read` | 200, aviso con su lectura; cuerpo `{}` |

La lectura exige sesión, `Origin` y CSRF.

## Web

La cabecera muestra «Avisos» con el total sin leer. `/avisos` lista la bandeja con título y
texto según el tipo, el lote, la fecha y un indicador «Nuevo». Abrir un aviso lo marca como
leído y lleva a la solicitud o la reserva. La bandeja y el contador consultan cada 15 s con la
pestaña visible, se pausan sin conexión y consultan de inmediato al volver a la pestaña o al
reconectar (anexos H p. 20).

## Outbox y worker

`outbox_events` guarda tipo, fila, versión, destinatario, datos del aviso, estado
(`pending`, `processed`, `failed`), intentos, disponibilidad y reclamo. El worker:

1. Reclama hasta 50 eventos pendientes con `FOR UPDATE SKIP LOCKED` y un reclamo de 2 minutos.
2. Por cada evento inserta el aviso y marca el evento procesado en una transacción.
3. Ante un error reintenta con espera creciente (2 s al doble, tope 5 min, ±20 %); tras cinco
   intentos, o si un reclamo vencido ya los agotó, el evento queda `failed` con su código de error.

Es una tarea más del ciclo del worker, junto a [vencimientos](vencimientos.md) y
[fotos](fotos.md): una tanda por vuelta y, sin trabajo, espera 2 s. Necesita solo `DATABASE_URL`.

## Pruebas

| Comando | Qué comprueba |
| --- | --- |
| `npm --prefix api test` | Espera creciente y fallo visible, tandas de 50, liberación de fallos y transporte HTTP contra OpenAPI. |
| `npm --prefix api run db:test:notifications:compose` | PostgreSQL real: evento confirmado con la transición y ausente si se revierte, un aviso por evento al reprocesar, aceptación, permisos, oferta vencida que leer no reactiva, persistencia tras cerrar sesión, reclamo vencido retomado, dos workers en paralelo con 100 eventos y evento `failed`. |
| `npm --prefix api run test:web:notifications` | Chromium con API y worker reales: contador por consulta periódica, recuperación al reconectar, bandeja, lectura que lleva a una oferta vencida sin aceptar y bandejas separadas. Corre dentro de `test:web:compose`. |
