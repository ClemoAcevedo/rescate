# Operación: registros, salud y tareas pendientes (RNF04)

Cómo se observa el sistema en marcha (anexos H p. 22): qué registra la API y el worker,
qué dice `/health` y cómo se revisan a diario los errores y las tareas atrasadas. Qué
valores nunca entran a un registro está en [seguridad](seguridad.md#registros-sin-secretos).

## Registros

La API y el worker escriben una línea JSON por evento en la salida estándar.

| Evento | Quién | Campos |
| --- | --- | --- |
| `request` | API, toda solicitud salvo `/health` | `requestId` generado, `operation` (método y plantilla de la ruta, por ejemplo `GET /public/lots/:lotId`), `status` (`null` si la conexión se cortó antes de responder), `durationMs`, `completed` (`false` si la respuesta no terminó) |
| `request_failed` | API, fallo no previsto | `requestId` de su solicitud y `code` técnico |
| `worker_backlog` | Worker, cada minuto | `queue` (`expiries`, `notifications` o `photos`), `pending`, `delaySeconds` de la tarea más antigua y `failed` |
| `worker_error` | Worker, vuelta fallida | `code` técnico; reintenta a los 5 s |

Un fallo se correlaciona con su solicitud por `requestId`: la línea `request` del mismo
identificador da la operación, el estado y la duración. Una solicitud que no llega a una
ruta (cuerpo inválido, 404 o límite por IP) se registra con `operation` `(sin ruta)`.
Los eventos de cada cola (`lot_expiry*`, `outbox_event_failed`, `photo_*`) están en
[vencimientos](vencimientos.md), [avisos](avisos.md) y [fotos](fotos.md).

## Salud

`GET /health` consulta PostgreSQL y lee el último ciclo exitoso del worker. El contrato
está en [OpenAPI](api/openapi.yaml).

| Situación | Respuesta |
| --- | --- |
| Base disponible | 200 `{"status":"ok","database":"ok","worker":"ok"}` |
| Base disponible, worker sin ciclo exitoso en 60 s | 200 con `"worker":"stopped"` |
| Base disponible sin la migración de K036 | 200 con `"worker":"unknown"` |
| Base caída o sin respuesta en 3 s | 503 `{"status":"unavailable","database":"unavailable","worker":"unknown"}` |

El estado general depende solo del proceso y la base: un worker detenido no bloquea un
despliegue de la API. El smoke de despliegue sí exige base y worker disponibles.

El worker escribe `worker_heartbeat` cada 10 s, solo después de una vuelta sin error:
un worker que falla en cada vuelta también figura `stopped`. Los fallos que una cola
reintenta por su cuenta no cortan el latido; se ven en `failed`. Con varios workers
basta que uno avance, así que uno caído junto a otro sano no se nota.

`/health` no pasa por el límite por IP ni se registra. Hay una sola consulta de salud a
la vez, hasta que termina, aunque las respuestas ya hayan vencido a los 3 s: con la base
colgada, las comprobaciones siguientes no ocupan más conexiones del pool.

## Revisión diaria

Nada envía alertas: Operación revisa una vez al día (anexos H p. 22).

1. Con `DATABASE_URL` de producción, ejecutar `npm --prefix api run ops:status`. Muestra
   si el worker está activo, la demora de cada cola y las tareas en error con su
   identificador y código. Solo lee. Si la base no responde, lo dice y termina con
   código 1.
2. En los registros de la API en Railway, buscar `request_failed` y `"status":5` del
   último día. Con el `requestId` de un `request_failed`, la línea `request` da la
   operación que falló.
3. En los registros del worker, buscar `worker_error`.
4. La antigüedad de la copia de la base se revisa según K053 (#56).

| Cola | Pendiente | En error: no se reintenta sola |
| --- | --- | --- |
| `expiries` | Lote con cierre u oferta vencidos sin registrar, incluido el último intento en curso | Lote con `expiry_attempts` agotados y sin concesión vigente; se devuelve al worker como indica [vencimientos](vencimientos.md) |
| `notifications` | Evento `pending` del outbox | Evento `failed`, o `pending` con los intentos agotados y la concesión vencida (`LEASE_EXPIRED`, su worker murió); ver [avisos](avisos.md) |
| `photos` | Foto `pending` de validar | Foto rechazada por `processing_failed`; quien opera el lote la vuelve a cargar ([fotos](fotos.md)) |

`failed` cuenta todo lo acumulado: baja solo cuando cada tarea se corrige.

## Pruebas

| Comando | Qué comprueba |
| --- | --- |
| `npm --prefix api test` | Línea por solicitud con plantilla de la ruta, `(sin ruta)` y estado `null` si se corta; `request_failed` con el mismo identificador; salud con base disponible o no. |
| `npm --prefix api run db:test:operations:compose` | PostgreSQL real y procesos reales del worker: salud sin worker, latido, demora por cola, fallo real correlacionado con su solicitud, `kill -9` detectado como worker detenido, `ops:status` con un lote atrasado, lotes en error, el último intento en curso como pendiente y un aviso abandonado, recuperación al reiniciar, salud 503 sin base y con la base colgada (llamadas simultáneas y sucesivas con una sola conexión), `ops:status` sin base o con la base que deja de responder tras la salud, y base sin migrar. |
