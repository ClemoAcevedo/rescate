# Vencimientos: lotes, reservas y ofertas (RF08)

El worker registra lo que vence con el tiempo: el cierre de un lote publicado y las
ofertas de la [cola de espera](cola-de-espera.md) que nadie aceptó a tiempo. La API
no depende de él: desde el cierre o la hora de la oferta ya responde como vencido,
aunque el worker esté detenido. Las decisiones y alternativas están en
[ADR 0011](adr/0011-vencimientos-con-concesion.md).

## Reglas

- **Cierre del lote.** Al llegar `pickup_ends_at`, un lote publicado pasa a `expired`
  con `closed_at` igual al cierre ([ADR 0008](adr/0008-estado-del-lote-y-cierre-logico.md)).
  Sus reservas confirmadas vencen con el cierre como término y sin código, la espera
  termina y todo F, O y R pendiente pasa a X; E se conserva (anexos B p. 4).
- **Oferta vencida.** En un lote abierto, la oferta termina a su hora, libera O → F y
  lo libre se ofrece a quien sigue en la cola, igual que al rechazar
  ([ADR 0010](adr/0010-cola-fifo-y-ofertas.md)).
- **Sin prórroga.** Los términos son el cierre o la hora de la oferta, nunca el
  instante en que el worker los procesa. Un retraso no extiende ningún plazo.
- **Una sola vez.** Todo ocurre en una transacción bajo el bloqueo del lote. Repetir el
  registro, o dos workers sobre el mismo lote, no libera dos veces.
- **Misma respuesta antes y después.** Reservar o entrar a la espera en un lote vencido
  responde 409 esté o no registrado el cierre; cancelar o retirar también.

## Reclamo, concesión y reintentos

El worker reclama un lote por vuelta: el de vencimiento pendiente más antiguo. El
reclamo suma un intento en `expiry_attempts` y concede el lote por un minuto en
`expiry_claimed_until`, ambos con el reloj de PostgreSQL. Salta los lotes bloqueados
por un comando, sin gastar intentos.

| Situación | Resultado |
| --- | --- |
| Registro exitoso | Se suelta la concesión y los intentos vuelven a 0. |
| Falla la transacción | Se revierte entera. El lote se pospone 30 s por intento. |
| El worker muere | Nada queda a medias. Otro worker lo retoma al vencer la concesión. |
| Quinto fallo | Se registra `lot_expiry_exhausted` y el lote no se vuelve a reclamar. |

El reclamo elige el lote con una sentencia y lo reclama con otra, ya bloqueado, que
vuelve a comprobar que siga pendiente. Así un worker no reclama un lote que otro acaba
de registrar con una foto anterior de la base.

Un lote agotado sigue respondiendo como vencido. Tras revisar la causa, reiniciar
`expiry_attempts` a 0 lo devuelve al worker. Los eventos `lot_expiry`,
`lot_expiry_retry` y `lot_expiry_exhausted` registran el lote, el intento y un
código de error, sin SQL ni datos personales.

## Backend

[Composition](../api/src/composition.ts) arma el worker con
[Application](../api/src/application/expiries/use-cases.ts), la regla de
[Domain](../api/src/domain/lots.ts) y el
[repositorio PostgreSQL](../api/src/infrastructure/postgres/expiry-repository.ts),
que reutiliza el asiento de la cola de
[waitlist-queue.ts](../api/src/infrastructure/postgres/waitlist-queue.ts). El worker
no necesita `PICKUP_CODE_KEY`. Con `DATABASE_URL` registra vencimientos aunque no
tenga almacenamiento de fotos. `WORKER_EXPIRIES=off` los apaga; solo lo usan las
pruebas que mueven plazos sobre una base compartida y esperan vencimientos sin
registrar.

## Pruebas

| Comando | Qué comprueba |
| --- | --- |
| `npm --prefix api test` | Regla de cierre, registro único con el instante del cierre, reintentos espaciados, agotamiento y configuración del worker. |
| `npm --prefix api run db:test:expiries:compose` | PostgreSQL real y procesos reales del worker: API con worker detenido, cierre de lote y reservas, oferta vencida que pasa a la siguiente, cierres simultáneos, concesión de un worker caído, `kill -9` a mitad del registro, dos workers, reintentos agotados y conciliación. |
| `npm --prefix api run db:test:queue-worker:compose` | Flujo de [cola](cola-de-espera.md) y avisos con `kill -9` al worker tras reclamar una oferta vencida y una tanda de avisos; el reiniciado la retoma una sola vez. |
| `npm --prefix api run db:test:reservations:compose` y `db:test:waitlist:compose` | El mismo caso de uso registra el cierre de lotes con reservas y con cola. |
