# Reservas: cancelación, código de retiro y entrega (RF05, RF06, RF08)

Una reserva confirmada nace con la reserva directa de [lotes](lotes.md#búsqueda-y-reserva-directa)
y termina una sola vez: cancelada por su titular, retirada ante un operador del
establecimiento o vencida al cierre del lote. El contrato HTTP está en
[OpenAPI](api/openapi.yaml); las decisiones y alternativas, en
[ADR 0007](adr/0007-codigo-de-retiro-y-transiciones.md).

## Reglas

- **Estado vigente.** Una reserva confirmada cuyo lote cerró es `expired` aunque el
  trabajador no lo haya registrado. Desde el cierre no se cancela ni se retira.
- **Cancelar.** Solo el titular, antes del cierre. Invalida el código y devuelve
  los packs a libres (R → F) en la misma transacción. Repetir sobre una cancelada
  responde lo mismo y no libera otra vez. Una retirada o vencida responde 409.
- **Código.** Cada reserva recibe uno nuevo: ocho símbolos sin I, L, O ni U. El
  titular lo consulta mientras la reserva está confirmada; terminada, el backend
  borra su cifrado y una captura del código deja de servir.
- **Revisar.** Un operador con membership sobre el establecimiento del lote ve la
  reserva de ese código, también si fue cancelada, venció o ya se retiró. No la
  consume ni la garantiza. Un código inexistente, mal escrito o de otro lote
  responde igual (404), sin más información.
- **Confirmar el retiro.** Vuelve a comprobar permiso, reserva, código y ventana
  bajo bloqueo aunque la revisión haya sido válida. Se retira desde el inicio de la
  ventana y antes de su cierre. Registra una única entrega completa (R → E). La
  misma clave del operador reproduce el resultado; otro intento informa que ya se
  retiró.
- **Vencer.** El registro mueve R → X con el cierre como instante de término. Repetirlo no
  libera de nuevo. `expireDue` de Application lo aplica por lotes para el
  trabajador de K028 (#31).
- **Privacidad.** El código solo viaja en cuerpos JSON: nunca en rutas, consultas,
  listados ni registros. Una reserva ajena responde 404 igual que una inexistente.

## Contrato HTTP

| Método | Ruta | Quién | Resultado |
| --- | --- | --- | --- |
| GET | `/reservations` | Titular | 200, sus reservas sin código, páginas de 20 |
| GET | `/reservations/:reservationId` | Titular | 200, detalle con `pickupCode` solo si está confirmada |
| POST | `/reservations/:reservationId/cancel` | Titular | 200, cancelada; cuerpo `{}` |
| POST | `/lots/:lotId/pickup-reviews` | Operador | 200, reserva del código y `canConfirm` |
| POST | `/lots/:lotId/pickups` | Operador | 201, entrega; cuerpo con `reservationId`, `code` e `idempotencyKey` |

Los comandos exigen sesión, `Origin` y CSRF. La revisión usa POST para que el
código no vaya en la URL; no cambia estado. `canConfirm` es `false` con estado
`confirmed` cuando la ventana aún no comienza. Revisar de nuevo el código muestra
el estado que provocó un 409 al confirmar.

## Vista del titular

`/reservas` muestra las reservas propias, incluidas canceladas, retiradas y vencidas,
en páginas de 20. `/reservas/:id` consulta el estado vigente y muestra cantidad,
lugar, condiciones, ventana en la zona del lote e instantes de creación y término.
El detalle organiza los datos con etiquetas y destaca el código en un bloque propio.
El aviso de solicitud registrada enlaza al detalle vigente y mantiene el identificador
como dato secundario. Los códigos permanecen solo en memoria del detalle: no aparecen en el listado,
URLs ni almacenamiento del navegador.

El detalle muestra el código únicamente con una respuesta válida y confirmada,
antes del cierre y sin una cancelación pendiente de comprobar. Al finalizar la
ventana lo oculta y ofrece consultar el estado; vuelve a consultar al regresar a
la pestaña y cada quince segundos mientras está visible. Un resultado de creación
reproducido por idempotencia lleva al detalle para conocer el estado actual, pues puede corresponder a una reserva ya terminada.

Cancelar pide confirmación en un bloque de advertencia dentro de la tarjeta y
bloquea envíos simultáneos. La acción destructiva y la opción de conservar la reserva
se separan y se apilan en móvil. No anuncia cancelación
hasta recibir el estado `cancelled`. Ante una respuesta perdida oculta el código
y permite consultar el estado o repetir la cancelación de la misma reserva. Un
conflicto conserva el aviso hasta consultar el resultado vigente. El registro
terminado sigue accesible desde el historial.

La reserva directa guarda clave y cantidad por actor y lote en `sessionStorage`
antes de enviar. Navegar o recargar la misma pestaña recupera esa intención, incluso
si ya no queda stock o el lote cerró. Un reintento conserva ambas; la respuesta de
creación no aporta un código ni acredita el estado vigente. Si el navegador no
permite guardar la intención, el comando no se inicia.

## Backend

Recorrido: [router](../api/src/http/reservations-router.ts) →
[Application](../api/src/application/reservations/use-cases.ts) →
[reglas](../api/src/domain/reservations.ts) /
[PostgreSQL](../api/src/infrastructure/postgres/reservation-repository.ts) y
[código](../api/src/infrastructure/crypto/pickup-codes.ts).

Cancelar, retirar y vencer toman el bloqueo del lote de
[lot-lock.ts](../api/src/infrastructure/postgres/lot-lock.ts), releen la reserva
y deciden con el reloj de PostgreSQL. El estado, el código, el contador y la
entrega se escriben con el mismo cliente. `UPDATE … WHERE status = 'confirmed'` y
los CHECK de `commitments` impiden una segunda transición o un código legible en
una reserva terminada. La reserva directa contrasta R con las reservas confirmadas
y E con las entregas antes de asignar ([ADR 0006](adr/0006-inventario-del-lote.md)).

`PICKUP_CODE_KEY` (32 bytes en base64, fuera de Git) cifra los códigos y deriva su
huella. Compose trae una clave ficticia que la API rechaza en producción
([despliegue](despliegue.md)).

## Pruebas

| Comando | Qué comprueba |
| --- | --- |
| `npm --prefix api run test:web:reservations` | Navegador con HTTP controlado: cancelación pendiente o perdida, reintento, conflictos y permisos, código inválido, cierre con la vista abierta, historial, páginas y recuperación de intención tras recarga. Requiere Vite sin mocks de identidad. |
| `npm --prefix api test` | Reglas de plazo y transición, normalización, cifrado y huella, y recorrido HTTP contra OpenAPI con repositorio en memoria. |
| `npm --prefix api run db:test:reservations:compose` | PostgreSQL real: código cifrado, captura cancelada, nuevo código por reserva, dos operadores y reintentos, cancelar contra retirar en 20 reservas, plazos sin trabajador, vencimiento repetido, espera de bloqueo, rollback y conciliación de R, E y X. |
| `npm --prefix api run db:test:compose` | Restricciones de estado, término, código y entregas, y rollback de la migración. |

`test:web:compose` ejecuta también la prueba con PostgreSQL en CI.
La prueba de navegador acepta el certificado HTTPS autofirmado del entorno local
en sus contextos de Playwright.

## Limitaciones

- La pantalla del operador corresponde a K024 (#26).
- El límite de cinco fallos de revisión por operador cada quince minutos es K034 (#37).
- El trabajador que registra vencimientos es K028 (#31).
