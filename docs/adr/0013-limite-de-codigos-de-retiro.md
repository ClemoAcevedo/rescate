# ADR 0013: límite de códigos de retiro por operador

Estado: adoptada para K034. Concreta la fila «Revisión de código» de anexos H p. 21
(también G p. 16) sobre [ADR 0007](0007-codigo-de-retiro-y-transiciones.md).

## Decisión

**Qué es un fallo.** Un código que no corresponde a una reserva del lote: inexistente,
mal escrito o de otro lote; al confirmar, uno que no corresponde a la reserva indicada.
El código válido de una reserva cancelada, vencida o retirada no es un fallo: la
revisión responde su estado. Tampoco lo son el 403 sin membership, el lote inexistente
ni el cuerpo inválido, que no comparan ningún código. Una clave de confirmación repetida
con otro código responde 409 sin contar: solo se compara con la reserva que ese operador
ya retiró con esa clave, cuyo código está consumido y no habilita otra.

**Revisar y confirmar comparten el límite.** Ambos comparan el código con la base, así
que cuentan para el mismo operador y quedan suspendidos juntos. Cinco fallos en 15
minutos suspenden 15 minutos. Mientras dure, las dos rutas responden 429 con
`Retry-After` antes de buscar el código, también con el código correcto, y no suman
fallos ni extienden el plazo. Es la regla del login por cuenta, en
[`attempts.ts`](../../api/src/domain/attempts.ts) para ambos.

**Persistido y serializado por operador.** `pickup_code_security_state` guarda la
suspensión y `pickup_code_failures` el instante de cada fallo, sin el código, su huella
ni el lote. `withPickupAttempts` toma esa fila con `FOR UPDATE` antes que la clave y el
lote, relee fallos y reloj de la base y ejecuta revisar o confirmar en la misma
transacción. El fallo se confirma antes de responder 404. Varios intentos simultáneos
del mismo operador se evalúan uno tras otro: después del quinto fallo, los siguientes
responden 429 sin registrar otro.

**Límite por origen en memoria.** Las 30 revisiones por IP cada minuto son una ventana
móvil por proceso, como el límite de login por IP; H p. 21 solo exige persistir los
fallos de acceso y de código. Cuentan también las confirmaciones, por la misma razón que
la suspensión. Se cobra después de comprobar lote y membership, justo antes de comparar
el código: una cuenta sin permiso no gasta el cupo de los operadores que comparten su
origen.

## Alternativas descartadas

- **Contador en memoria.** Reiniciar la API borraría la suspensión; H p. 21 pide
  guardar los fallos en PostgreSQL.
- **Contar por lote o por establecimiento.** E1 fija el límite por operador. Contar por
  lote dejaría probar cinco códigos en cada lote del establecimiento.
- **Suspender solo la revisión.** Confirmar también compara el código; sin suspenderlo,
  confirmar serviría para seguir probando.
- **Contar también códigos válidos de reservas terminadas.** Mostrar su estado es parte
  de la revisión (RF06) y no acerca a adivinar un código vigente.
- **Cobrar el límite por origen antes del permiso.** Con un proxy delante, todos los
  clientes pueden compartir la IP: cualquier cuenta agotaría el cupo de todos los
  operadores con solicitudes que ni siquiera comparan un código.
- **Advisory lock en lugar de la fila del operador.** También serializa, pero la fila ya
  guarda la suspensión y repite el patrón de `login_security_state`.
- **Guardar el lote o la huella del intento.** No hacen falta para limitar, y la huella
  de un código erróneo identificaría intentos sin aportar a la regla.

## Consecuencias

Un operador suspendido no puede retirar durante 15 minutos aunque tenga el código
correcto; otro operador del mismo establecimiento sí. La serialización abarca todos los
lotes del operador: una confirmación que espera el bloqueo de un lote demora sus otros
intentos, y una espera de más de 2 s responde 503. Una confirmación perdida se reproduce
con su clave al terminar la suspensión. Los fallos vencidos se borran en el siguiente
fallo del operador, así que cada uno conserva como máximo cinco.
