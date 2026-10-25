# ADR 0011: vencimientos reclamados por lote con concesión

Estado: adoptada para K028. Concreta RF08 (anexos A p. 2, B p. 4 y H p. 20) sobre
[ADR 0006](0006-inventario-del-lote.md), [ADR 0007](0007-codigo-de-retiro-y-transiciones.md),
[ADR 0008](0008-estado-del-lote-y-cierre-logico.md) y
[ADR 0010](0010-cola-fifo-y-ofertas.md).

## Decisión

**Un caso de uso por lote.** `expireLot` bloquea el lote y, con el reloj de la base,
asienta su cola, vence sus reservas si cerró y lo pasa a `expired`. Todo F, O y R
pendiente pasa a X, con el cierre como término (B p. 4). Reemplaza a `expireDue` de
reservas y `settleDue` de la cola, que recorrían cada tabla por separado.

**El lote es la tarea.** `lots.expiry_attempts` y `lots.expiry_claimed_until` guardan
el reclamo. Un lote está pendiente si está publicado y cerró, o si tiene una oferta
vencida. `claimNext` toma el más antiguo con `FOR UPDATE SKIP LOCKED`, suma un intento
y lo concede. Un registro exitoso reinicia los intentos, porque un lote abierto puede
tener varias ofertas que vencen en momentos distintos.

**Reintentos acotados en Application.** Concesión de un minuto, cinco intentos y
espera de 30 s por intento. Liberar tras un fallo exige el mismo número de intento,
así un worker atrasado no acorta la concesión de quien retomó el lote. Al agotarse,
el lote queda para revisión.

## Alternativas descartadas

- **Tabla de tareas propia.** Exige crear la tarea al publicar y en cada oferta, y
  mantenerla al día con el lote. El lote ya es la unidad que se bloquea, y su fila
  basta para guardar el reclamo.
- **Recorrer sin concesión, como `expireDue`.** El registro es idempotente, pero dos
  workers bloquearían el mismo lote y un fallo persistente se reintentaría sin límite.
- **Registrar al leer.** Una lectura escribiría bajo bloqueo; la API ya decide con el
  cierre ([ADR 0007](0007-codigo-de-retiro-y-transiciones.md)).
- **Dejar F en el lote vencido.** B p. 4 indica que al cerrar todo F, O y R pendiente
  pasa a X; F en un lote cerrado parecería asignable.

## Consecuencias

Reservar o entrar a la espera en un lote `expired` responde 409, igual que en uno
cerrado sin registrar, para que la respuesta no dependa del worker. Un lote agotado
necesita revisión manual (`expiry_attempts = 0`). La cola general de trabajos y su
recuperación corresponden a K031 (#34).
