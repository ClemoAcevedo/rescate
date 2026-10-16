# Cola de espera y ofertas (RF07)

Cuando una cantidad no se puede reservar directamente, la persona entra a la cola FIFO
del lote. Si hay packs libres, la primera solicitud recibe una oferta por lo que haya,
aunque sea menos de lo pedido; al aceptarla se crea la reserva. Las reglas de negocio
están en [ADR 0002](adr/0002-ofertas-parciales.md) y las decisiones de implementación en
[ADR 0010](adr/0010-cola-fifo-y-ofertas.md). El contrato HTTP está en
[OpenAPI](api/openapi.yaml) (etiqueta `Waitlist`).

## Reglas

- **Ingreso.** Solo si la cantidad no se puede reservar directamente: no alcanza o ya hay
  personas esperando. Con libres suficientes y la cola vacía responde 409 y corresponde
  reservar directamente. Una solicitud en espera no retiene packs. Un usuario tiene una
  solicitud abierta o una reserva confirmada por lote, no ambas (RF04).
- **Orden.** FIFO por creación, asignada bajo el bloqueo del lote. Nadie adelanta: la
  reserva directa también se rechaza mientras alguien espera.
- **Oferta.** Cada vez que se liberan packs (cancelar, rechazar, vencer) o entra una
  solicitud con libres, se ofrece en orden a quienes esperan lo que cabe: la cantidad
  pedida o, si no alcanza, todo lo que queda (F → O). Dura diez minutos o hasta el cierre
  del lote, lo que ocurra primero, y no se emite con menos de un minuto de ventana.
- **Aceptar.** Confirma solo la cantidad ofrecida (O → R, sin descontar F otra vez), emite
  el código de retiro de la nueva reserva y cierra la solicitud: no queda saldo ni
  prioridad por lo no ofrecido. Repetir devuelve la misma reserva.
- **Rechazar, vencer o salir.** Cierran la solicitud sin prioridad ni reingreso
  automático; volver exige una solicitud nueva con posición nueva. Rechazar o vencer
  libera solo lo retenido: a F si el lote sigue asignando, a X si ya cerró. Salir solo
  corresponde a quien espera sin oferta. Repetir no libera dos veces.
- **Vencimiento sin trabajador.** Una oferta pasada de hora o la espera de un lote cerrado
  se informan `expired` al leer y ya no se aceptan, aunque nadie las haya registrado. El
  registro ocurre bajo el bloqueo del lote en el siguiente comando que lo toca (ingresar,
  aceptar, rechazar, cancelar, reservar) o cuando lo registra el worker
  ([vencimientos](vencimientos.md)).
- **Privacidad.** Una solicitud ajena responde 404 igual que una inexistente.

## Contrato HTTP

| Método | Ruta | Resultado |
| --- | --- | --- |
| POST | `/public/lots/:lotId/waitlist` | 201, solicitud (con oferta si había libres); cuerpo `quantity` e `idempotencyKey` |
| GET | `/waitlist` | 200, solicitudes propias, páginas de 20 |
| GET | `/waitlist/:entryId` | 200, estado vigente, posición, oferta y `reservationId` al aceptar |
| POST | `/waitlist/:entryId/accept` | 200, aceptada; el código se consulta en `/reservations/:id` |
| POST | `/waitlist/:entryId/decline` | 200, rechazada |
| POST | `/waitlist/:entryId/leave` | 200, retirada de la cola |

Los comandos exigen sesión, `Origin` y CSRF, con cuerpo `{}` salvo el ingreso. La misma
clave de ingreso devuelve la solicitud existente con su estado vigente.

## Vista del titular

El detalle del lote ofrece «Unirme a la lista de espera» y enlaza a `/lotes/:id/espera`. La persona elige cantidad y pulsa
«Entrar voluntariamente a la espera»; navegar a la pantalla no crea solicitudes.
El ingreso conserva cantidad y clave por actor y lote en `sessionStorage` antes de
enviar. Ante una respuesta perdida, incluso tras recargar, el reintento usa la
misma intención. Si el almacenamiento falla, no se envía. La API decide si corresponde
esperar o reservar directamente.

`/espera` muestra solicitudes propias e historial paginado; `/espera/:id` consulta
posición («Tu posición en la cola»), cantidad solicitada, cantidad ofrecida, condiciones
y ventana de retiro.
La espera no retiene packs; la oferta los retiene pero exige aceptación explícita;
solo una aceptación confirmada enlaza a la reserva y su código de retiro.
Una oferta parcial explica que aceptar cierra la solicitud sin saldo prioritario.
Rechazar o salir explica la pérdida de posición; volver exige un ingreso voluntario.

El detalle actualiza el reloj cada segundo, consulta cada quince segundos mientras
la pestaña está visible y vuelve a consultar al regresar. El reloj es orientativo:
el vencimiento local bloquea acciones y la API verifica nuevamente la vigencia al
aceptar con el reloj de la base. Un aviso antiguo nunca confirma una reserva.
Los envíos simultáneos se bloquean; una respuesta perdida o un conflicto deshabilita
acciones hasta consultar el estado vigente. Consultar puede recuperar una aceptación
ya aplicada sin volver a enviar el comando. No hay aceptación ni reingreso automático.

## Backend

Recorrido: [router](../api/src/http/waitlist-router.ts) →
[Application](../api/src/application/waitlist/use-cases.ts) →
[reglas](../api/src/domain/waitlist.ts) /
[PostgreSQL](../api/src/infrastructure/postgres/waitlist-repository.ts).

[waitlist-queue.ts](../api/src/infrastructure/postgres/waitlist-queue.ts) asienta la cola
de un lote ya bloqueado: registra ofertas vencidas, cierra la espera de un lote que dejó
de asignar y aplica el plan de `planOffers`. Lo llaman, dentro de la misma transacción,
ingresar, rechazar, cancelar una reserva, vencer reservas y la reserva directa. Los
comandos del titular devuelven sus rechazos en lugar de lanzarlos dentro de la
transacción, para conservar los vencimientos que registraron.

El contador O se contrasta con las ofertas vigentes junto con R y E; una discrepancia
bloquea ingresar, reservar y ofrecer ([ADR 0006](adr/0006-inventario-del-lote.md)).

## Pruebas

| Comando | Qué comprueba |
| --- | --- |
| `npm --prefix api run test:web:waitlist` | Navegador con HTTP controlado: ingreso voluntario y recuperación tras recarga, posición, oferta parcial, doble envío, respuesta perdida, rechazo, salida, vencimiento local y rechazo del servidor con reloj desactualizado, privacidad, validación y páginas. Requiere Vite sin mocks de identidad. |
| `npm --prefix api test` | Plan de ofertas (caso Ana 10, Pedro 3, Juan 1 con 4 libres), plazos, estado vigente y transiciones. |
| `npm --prefix api run db:test:waitlist:compose` | PostgreSQL real vía API y contrato: oferta parcial, aceptar, rechazar, vencer sin trabajador, registro de vencimientos, cierre del lote con todo F, O y R en X, plazos, idempotencia, propiedad, ingresos y aceptaciones simultáneos y conciliación de Q, R y O. |
| `npm --prefix api run db:test:compose` | Restricciones de `waitlist_entries` y rollback de la migración. |

## Limitaciones

- La prueba integrada de cola, avisos y recuperación del trabajador es K031 (#34).
- Las ofertas emitidas y vencidas generan [avisos](avisos.md) en la misma transacción.
