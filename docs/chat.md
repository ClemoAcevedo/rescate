# Chat de la reserva (RF13)

El titular y los operadores del establecimiento del lote coordinan el retiro con mensajes de
texto sobre una reserva. El contrato HTTP está en [OpenAPI](api/openapi.yaml) (etiqueta `Chat`)
y las decisiones de modelo y retención en [ADR 0016](adr/0016-chat-de-la-reserva.md).

## Reglas

- **Quién participa.** Leen y escriben el titular y cualquier operador miembro del
  establecimiento del lote. Para cualquier otra persona la reserva no existe y responde 404.
  Cada mensaje dice si lo escribió el titular o el establecimiento, sin revelar qué operador fue.
- **Cuándo se escribe.** Solo mientras la conversación está abierta. Cierra con lo primero que
  pase entre cancelar o retirar la reserva, el fin de la ventana de retiro y el cierre del lote.
  Una reserva vencida queda cerrada aunque el worker todavía no lo registre. Cerrada responde 409.
- **Bajo el bloqueo del lote.** El envío relee la reserva después de tomar el mismo bloqueo que
  cancelar, retirar y vencer ([ADR 0006](adr/0006-inventario-del-lote.md)). Un envío que compite
  con una cancelación entra solo si llegó antes, así que ningún mensaje queda después del cierre.
- **Reintentos.** Cada envío trae una clave UUID del autor. Repetirla con el mismo texto devuelve
  el mensaje original, incluso con la conversación ya cerrada. Usarla con otro texto u otra
  reserva responde 409.
- **Secuencia.** Cada mensaje recibe la siguiente secuencia de su reserva. La consulta periódica
  pide lo posterior a la última secuencia conocida, así que reconectar recupera lo perdido.
- **Texto.** Texto plano de 1 a 1000 caracteres después de recortar los bordes. Sin adjuntos,
  audio, escritura en vivo ni confirmaciones de lectura.
- **Límite.** 12 envíos por minuto y usuario con ráfaga de 3 ([seguridad](seguridad.md)).
- **No actúa.** Un mensaje no cambia la reserva, el inventario ni acredita el retiro.

## Retención

El historial se puede leer hasta treinta días después del cierre. Pasado ese plazo la API deja
de mostrarlo aunque el borrado no haya corrido. Una vez al día el worker borra el texto de esas
conversaciones y conserva la fila sin texto como resultado del envío, para que un reintento
tardío siga respondiendo lo mismo. Borrar otra vez no cambia nada.

## Contrato HTTP

| Método | Ruta | Resultado |
| --- | --- | --- |
| GET | `/reservations/:reservationId/messages?after=N` | 200, hasta 50 mensajes con secuencia mayor que `N`, `hasMore` y `open` |
| POST | `/reservations/:reservationId/messages` | 201, `{ id, sequence, createdAt }` del mensaje nuevo o del original |

El envío exige sesión, `Origin` y CSRF. La pantalla con consulta cada 5 s es K038 (#41).

## Cómo probar

`npm --prefix api run db:test:chat:compose` crea una base aislada, la migra y recorre por la API
real la conversación, los reintentos, el acceso ajeno, el límite, los envíos simultáneos, la
carrera con cancelar, los cierres por vencimiento, retiro del lote y entrega, y la retención.
