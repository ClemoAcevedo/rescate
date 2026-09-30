# ADR 0004: reserva directa e idempotencia

Estado: adoptada para K015. Resuelve el diseño D-08 de [#103](https://github.com/ClemoAcevedo/rescate/issues/103)
para reserva directa. RF04 y anexos E1 H exigen una reserva por intención y resultado
recuperable tras perder la respuesta. ADR 0002 conserva las reglas del protocolo posterior.

## Decisión

La intención lleva un UUID `idempotencyKey` en el cuerpo JSON. Se conserva el
contrato del cliente de descubrimiento existente. Una cabecera `Idempotency-Key`
era equivalente, pero habría requerido otro canal sin aportar valor a este único
comando. Se normalizan UUID a minúsculas antes de bloquear o comparar.

`commitments` conserva ID público, actor, lote, cantidad, instante y clave única por
actor. Estos campos reconstruyen el resultado de creación sin una segunda tabla:
201 y el mismo cuerpo, incluso al repetir después del cierre. La comparación exacta
de lote y cantidad detecta cambios de parámetros con 409; no se necesita un hash
para esos dos valores tipados. No hay caducidad ni limpieza de claves durante el piloto.
Los intentos rechazados o revertidos no consumen clave.

La transacción toma primero un advisory lock por actor/clave, lee el resultado
previo y, si falta, bloquea el lote. Así se serializa también una misma clave usada
en lotes diferentes. El bloqueo del lote protege la suma de reservas, el compromiso
activo y la inserción. Un error revierte clave y reserva juntas; solo se responde
éxito tras el commit. No se realizan llamadas externas bajo bloqueo.

Se descarta una tabla genérica de operaciones con JSON, hashes y códigos HTTP en
este alcance: solo hay reserva directa y su resultado ya está persistido. Al añadir
aceptaciones, retiro u otros comandos se deberá definir su espacio de claves y
conservar los resultados de creación, sin reutilizar las claves históricas ni
reconstruir respuestas de creación a partir de estados mutables.

El inventario de K015 deriva libres como cantidad publicada menos reservas
confirmadas. No introduce cinco contadores sin operaciones que los mantengan.
S04 deberá incorporar ofertas, entregas y cierres y garantizar su conciliación.

## Verificación

`db:test:discovery:compose` comprueba claves simultáneas, diferencias de mayúsculas,
parámetros distintos, aislamiento entre actores, reproducción tras cierre y rollback.
`test:web:compose` pierde una respuesta después del commit y comprueba que el
reintento del navegador conserva clave y cantidad y deja una sola reserva.
