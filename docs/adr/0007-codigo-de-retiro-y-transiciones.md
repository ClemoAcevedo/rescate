# ADR 0007: código de retiro y transiciones terminales de la reserva

Estado: adoptada para K022. Concreta RF05, RF06 y RF08 (anexos A p. 2, G pp. 13 y
16, H pp. 20–21 e I p. 27) sobre el inventario y el bloqueo común de
[ADR 0006](0006-inventario-del-lote.md).

## Decisión

**Transiciones.** Una reserva confirmada termina una sola vez: cancelada por su
titular, retirada por un operador del establecimiento o vencida al cierre del lote.
`commitments.status` admite esos cuatro valores y `ended_at` es obligatorio en los
terminales. Cada transición toma el bloqueo del lote, relee la reserva con el reloj
de PostgreSQL y escribe estado y contador con el mismo cliente; el `UPDATE … WHERE
status = 'confirmed'` impide una segunda transición aunque falle una regla.

| Transición | Quién | Cuándo | Movimiento |
| --- | --- | --- | --- |
| Cancelar | Titular | Antes del cierre | R → F |
| Retirar | Operador con membership | Desde el inicio y antes del cierre | R → E y registro en `deliveries` |
| Vencer | API al decidir; trabajador al registrar | Desde el cierre | R → X |

**Vencimiento sin trabajador.** Una reserva confirmada cuyo lote cerró se informa y
se trata como vencida aunque no se haya registrado (anexos A p. 2). Registrarla
mueve R → X con `ended_at` igual al cierre, no al instante del proceso; repetirlo no
encuentra confirmadas y no libera. K028 programa ese registro.

**Código.** Ocho símbolos del alfabeto de Crockford (32 símbolos, sin I, L, O, U),
generados con `crypto.randomInt`. Se guarda cifrado con AES-256-GCM y se busca por
HMAC-SHA-256; ambas subclaves salen por HKDF de `PICKUP_CODE_KEY`, que vive fuera de
la base. La huella es única en toda la historia, así que un código no se reutiliza.
Un estado terminal borra el cifrado: el código ya no se puede mostrar, y la huella
solo sirve para que la revisión informe por qué se rechaza.

**Revisar y confirmar.** El operador envía el código en el cuerpo de
`POST /lots/{lotId}/pickup-reviews`; la revisión muestra la reserva sin consumirla.
Confirmar (`POST /lots/{lotId}/pickups`) recibe reserva, código y una clave de
intención por operador, y vuelve a validarlo todo bajo bloqueo. La entrega guarda
operador y clave, con unicidad por reserva y por operador/clave: un reintento
reproduce el 201 original y otro intento responde que ya se retiró.

**Lectura del titular.** `GET /reservations/{id}` revela el código solo mientras la
reserva está confirmada. Las reservas confirmadas antes de esta migración reciben su
código en la primera consulta, bajo el bloqueo del lote.

## Alternativas descartadas

- **Guardar solo un hash del código.** Permite validarlo, pero el titular no podría
  volver a consultarlo (RF06) sin reemitirlo, y E1 no define rotación.
- **Texto legible con índice único.** Una copia de la base expondría todos los
  códigos vigentes; H p. 21 exige cifrado con clave externa.
- **Derivar la clave de `CSRF_SIGNING_KEY`.** Evitaba configurar otro secreto, pero
  rotar la clave CSRF dejaría ilegibles los códigos vigentes.
- **Solo un estado `delivered` sin tabla de entregas.** E es un hecho histórico con
  operador e instante (modelo inicial) y respalda el contraste del contador.
- **Revisar con GET y el código en la consulta.** Lo dejaría en URL, historial y
  registros de acceso (anexos G p. 13).
- **Registrar el vencimiento al leer.** Una lectura escribiría bajo bloqueo; la API
  ya decide con el cierre y el trabajador registra el efecto.

## Consecuencias

`PICKUP_CODE_KEY` es obligatoria para iniciar la API; perderla deja los códigos
vigentes sin poder mostrarse ni verificarse. El límite de fallos de revisión por
operador (cinco cada quince minutos, H p. 21) corresponde a K034 (#37). Cerrar o retirar
un lote por incidencia deberá terminar sus reservas confirmadas y borrar sus códigos
de la misma forma.
