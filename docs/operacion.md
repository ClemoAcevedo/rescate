# Operación: registros, salud, tareas pendientes y copias (RNF04, RNF08)

Cómo se observa el sistema en marcha (anexos H p. 22): qué registra la API y el worker,
qué dice `/health` y cómo se revisan a diario los errores y las tareas atrasadas. Qué
valores nunca entran a un registro está en [seguridad](seguridad.md#registros-sin-secretos).
Cómo se copian y restauran la base y las fotos está en
[copia y restauración](#copia-y-restauración-rnf08).

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
4. `ops:status` lee el estado privado del respaldo: la copia debe tener menos de 24 h
   y el último intento debe estar correcto. Ausencia, error, intento aún en curso o
   copia antigua terminan con código 1. Consultar el servicio `backups` en Railway
   ante `backup_failed`; no imprime credenciales ni datos del origen.

| Cola | Pendiente | En error: no se reintenta sola |
| --- | --- | --- |
| `expiries` | Lote con cierre u oferta vencidos sin registrar, incluido el último intento en curso | Lote con `expiry_attempts` agotados y sin concesión vigente; se devuelve al worker como indica [vencimientos](vencimientos.md) |
| `notifications` | Destinatario de incidencia aún sin evento, o evento `pending` del outbox | Evento `failed`, o `pending` con los intentos agotados y la concesión vencida (`LEASE_EXPIRED`, su worker murió); ver [avisos](avisos.md) |
| `photos` | Foto `pending` de validar | Foto rechazada por `processing_failed`; quien opera el lote la vuelve a cargar ([fotos](fotos.md)) |

`failed` cuenta todo lo acumulado: baja solo cuando cada tarea se corrige.

## Copia y restauración (RNF08)

Anexos H p. 22 e I p. 27: copia lógica diaria de PostgreSQL, copia separada de las fotos
con un manifiesto de referencias y ensayo de restauración. La meta es recuperar en hasta
60 min desde el comienzo de la intervención con una copia de hasta 24 h.

| Comando | Qué hace |
| --- | --- |
| `npm --prefix api run backup:create [-- --salida <dir>]` | Copia la fuente de las variables `K053_SOURCE_*` en `api/.k053-results/<instante>-<commit>/` (o en `<dir>`, vacío). Imprime el sha256 de `manifest.json`. |
| `npm --prefix api run backup:restore -- <copia> [--anterior <ref>] [--manifiesto-sha256 <hex>] [--borrar]` | Restaura en una base nueva `rescate_k053_restore_*` del Compose, concilia y levanta la API. `--borrar` elimina esa base y sus fotos al terminar, también si falla. |
| `npm --prefix api run backup:reconcile -- <copia> [--manifiesto-sha256 <hex>]` | Concilia una base restaurada fuera del Compose (`K053_TARGET_DATABASE_URL`) y sus fotos (`K053_TARGET_PHOTO_STORAGE` `s3` o `local`). Solo lee. |
| `npm --prefix api run backup:rehearsal` | [Ensayo local](#ensayo-local) con datos ficticios. |
| `npm --prefix api run backup:scheduled` | Copia, cifra, verifica la subida y rota siete días completos; publica estado para Operación. |
| `npm --prefix api run backup:fetch -- --salida <dir> [--todas] [--descifrar <dir-vacío>]` | Descarga la última copia (o todas), verifica bytes y sha256; conserva el cifrado salvo petición explícita. |
| `npm --prefix api run backup:journal -- <copia> --salida <informe.json> [--decisiones <decisiones.json>]` | Identifica los compromisos posteriores/inciertos y sus contactos frente a la base restaurada; exige decisiones antes de declarar listo para reabrir. |

`pg_dump` y `pg_restore` corren en la imagen `postgis/postgis:16-3.5`. Los scripts nunca
imprimen URLs ni claves, y la contraseña llega a `pg_dump` en un archivo temporal 0600.
Una fuente fuera del equipo exige `sslmode=require` o `verify-*`, salvo
`K053_ALLOW_PLAINTEXT=1`.

### Qué guarda una copia

- `database.dump`: `pg_dump -Fc` sin dueños ni permisos.
- La imagen y la miniatura de cada foto `ready`. Los originales de `uploads/` no se
  copian ([fotos](fotos.md#respaldo)).
- `manifest.json`: commit, migraciones, versiones de PostgreSQL y PostGIS, conteos y
  agregados por tabla, sha256 del esquema `public`, del volcado y de cada objeto, y las
  fotos listas sin objeto en la fuente (`photos.missing`). Sin manifiesto, la copia está
  incompleta.

La copia solo lee: una transacción `REPEATABLE READ READ ONLY` exporta su instantánea y
`pg_dump --snapshot` la usa, así que volcado, conteos y fotos describen el mismo estado.
Si espera un bloqueo más de 10 s (por ejemplo, el `db:migrate` de un despliegue), falla y
lo libera.

### Conciliación

La restauración verifica el sha256 del volcado y de cada objeto, ejecuta `pg_restore` en
una transacción y compara. Termina con código 1 si algo falla, si la recuperación supera
60 min o si la copia supera 24 h. Informa los casos por identificador público, nunca
correos, textos ni códigos.

| Comprobación | Falla si |
| --- | --- |
| Versión | PostgreSQL de destino anterior al de la fuente, o PostGIS de otra versión mayor. |
| Migraciones | `pgmigrations` difiere del manifiesto o de `api/migrations`. |
| Conteos y esquema | Una tabla, un agregado o una definición de `public` difiere del manifiesto. |
| Secuencias | El próximo valor no supera el máximo de su columna. |
| Inventario | Q ≠ F + O + R + E + X, negativos, R/O/E distintos de sus registros, o un lote cerrado con F, O, R o cola. |
| Entregas | Un compromiso entregado sin exactamente una entrega, u otro con entrega. |
| Códigos | Código fuera de una reserva confirmada, huella repetida, código que no descifra con `K053_PICKUP_CODE_KEY` o que descifra con otra clave. |
| Incidencias y destinatarios | Estado distinto de la última versión, o destinatario sin su evento. |
| Outbox y chat | Evento procesado sin aviso o pendiente con aviso; secuencia de chat con huecos. |
| Fotos | Foto lista sin objeto, sha256 distinto u objeto sin foto. |

Después arranca la API sobre lo restaurado: `/health`, búsqueda, detalle y miniatura. Sin
lotes publicados en plazo, esas lecturas salen como `OMIT`. El reloj de recuperación
incluye comprobar la bandeja y el worker operativo sin errores; la comprobación opcional
del release anterior queda fuera de esa medición. El informe queda en `<copia>/restore-<base>.json`.

### Volver al release anterior

Como en [despliegue](despliegue.md#comprobación-y-recuperación), volver atrás no ejecuta
migraciones down. Con `--anterior <commit o deploy-<SHA>>`, la restauración comprueba que
las migraciones de ese release sean prefijo de las restauradas, lo compila en un worktree
temporal y levanta su API y su worker sobre otra copia de la base. El release anterior no
conoce las tablas nuevas: muestra los avisos ya generados, pero no las funciones que
agregaron.

### Programación y secretos

El servicio Railway `backups` usa [Dockerfile.backup](../api/Dockerfile.backup), contexto
`api/`, comando `node scripts/backup-scheduled.mjs`, cron `0 */12 * * *` (UTC), una
réplica y restart `NEVER`. Cada ejecución termina; el margen de doce horas permite
reintentar sin agotar inmediatamente las 24 h. El trabajo toma un advisory lock de
sesión propio: una ejecución manual concurrente no compite con la programada.

Recibe `DATABASE_URL` por la red privada Railway, `PHOTO_STORAGE=s3`, `PHOTO_S3_*` y
`BACKUP_ENCRYPTION_KEY` (32 bytes aleatorios en base64). `BACKUP_S3_*` permite un bucket
privado distinto; por omisión usa el de fotos con prefijo exclusivo `rescate-backups/v1/`.
`BACKUP_PG_TOOLS=native` usa pg_dump 16 dentro de la imagen, sin Docker anidado.
`K053_ALLOW_PLAINTEXT=1` solo corresponde al transporte interno privado de Railway;
los accesos desde fuera usan túnel SSH cifrado o TLS.

`BACKUP_TOOL_SHA` identifica el checkout que construyó el servicio y
`BACKUP_TOOL_DIRTY=0` una imagen del commit publicado. El workflow de release actualiza
esos valores y despliega el servicio junto con la versión compatible.

La copia se cifra con AES-256-GCM antes de subirla. Se vuelve a leer el archivo remoto
y se verifica sha256 y tamaño antes de publicar el marcador de completitud. Solo
entonces se rota: se conserva la última copia completa de cada uno de los siete días
más recientes, no siete ejecuciones. Una copia incompleta no desplaza una completa;
un inventario inconsistente detiene el borrado. El directorio temporal sin cifrar
se elimina al terminar, también ante error.

El estado privado `status.json` conserva el último éxito aunque falle el intento
siguiente. `ops:status` requiere `BACKUP_S3_*` o las variables de fotos de producción
para consultarlo. La clave del cifrado nunca se guarda junto al archivo ni en Git.

API y worker reciben otra clave `RECOVERY_JOURNAL_KEY`, con el scope
`RAILWAY_ENVIRONMENT_ID` (o `RECOVERY_JOURNAL_SCOPE` explícito). `RECOVERY_S3_*` permite
separar su bucket; por omisión usa el de fotos. El diario se conserva durante al menos
ocho días y mientras lo necesite la copia más antigua retenida. No rotar claves sin
conservar las anteriores hasta que caduquen sus copias y registros.

### Segunda copia y restauración

Operación y revisor conservan sus copias cifradas en equipos distintos y la clave
aparte (anexos H p. 22). `backup:fetch -- --todas --salida <directorio-nuevo>` descarga
las copias completas con sus metadatos y comprueba los hashes. El repositorio es
público: estas copias no se publican como artifacts de CI ni se agregan a Git.

Para una intervención:

1. Registrar el comienzo y pausar las escrituras de API y worker. Descargar y
   autenticar una copia de hasta 24 h:
   `backup:fetch -- --salida <cifradas> --descifrar <copia-vacía>`.
   La extracción autentica el archivo completo antes de escribir el destino y rechaza
   rutas absolutas, recorridos `..`, enlaces y dispositivos.
2. Crear un PostgreSQL/PostGIS compatible con volumen nuevo, separado de producción,
   y abrir el túnel SSH de Railway. Registrar IDs del entorno, volumen y despliegues;
   comprobar que difieren de los de producción. Restaurar en una base vacía creada
   desde `template0`, con `pg_restore --no-owner --no-privileges --exit-on-error
   --single-transaction`. No ejecutar migraciones down ni restaurar sobre la fuente.
3. Restaurar `objects/lot-photos/` en el almacenamiento del destino, conservando claves
   y bytes. En un ensayo, usar bucket separado o almacenamiento aislado: API/worker
   del ensayo no deben limpiar objetos del bucket activo. Conservar la clave original
   de los códigos de retiro.
4. Ejecutar `backup:reconcile` con `K053_TARGET_DATABASE_URL`,
   `K053_TARGET_PHOTO_STORAGE`, sus variables de fotos y `K053_PICKUP_CODE_KEY`.
   Debe pasar todo el manifiesto: esquema, inventario, entregas, códigos,
   incidencias/destinatarios, mensajes, avisos y fotos.
5. Ejecutar la conciliación del diario descrita abajo, resolver los casos y registrar
   las decisiones. No reabrir con casos inciertos pendientes.
6. Desplegar API y worker compatibles contra el destino. Comprobar `/health` con base
   y worker activos, búsqueda, detalle, fotos y bandeja autenticada; `test:deploy`
   comprueba el trayecto HTTPS de la web. Medir el tiempo completo desde el paso 1:
   debe ser hasta 60 min y la antigüedad de la copia hasta 24 h. Un paso omitido o
   fallido no acredita el ensayo (#206).
7. Reabrir solo después de conciliar y comprobar. Eliminar datos descifrados,
   informes privados, túneles y recursos del ensayo; conservar evidencia sin datos
   personales en la PR/release. La segunda copia cifrada y las claves se conservan
   según su retención.

La cuenta Railway debe pertenecer al proyecto. `railway ssh config --service postgres
--alias rescate-pg` prepara el acceso SSH; el túnel local puede usar
`ssh -o ExitOnForwardFailure=yes -N -L 127.0.0.1:15432:127.0.0.1:5432 rescate-pg`.
Las credenciales se cargan desde un gestor seguro o lectura silenciosa, nunca en argv,
stdout, archivos versionados ni variables `VITE_`.

### Compromisos posteriores a la copia

El [ADR 0022](adr/0022-diario-de-recuperacion.md) define el diario independiente:
intención antes del efecto y resultado mínimo después del COMMIT. Un fallo de
confirmación conserva una intención incierta; una cuenta creada después de la copia
sigue siendo contactable mediante su correo cifrado en ese diario.

Con la base restaurada aún cerrada, configurar su `K053_TARGET_DATABASE_URL`, la
`RECOVERY_JOURNAL_KEY`, el `RECOVERY_JOURNAL_SCOPE` del **origen** y su almacenamiento.
`backup:journal -- <copia> --salida <informe-nuevo.json>` solo consulta PostgreSQL y
objetos. Excluye resultados presentes en la copia y rechazos definitivos; incluye
resultados posteriores y cualquier intención incierta retenida. Un diario corrupto
impide generar un informe válido. El informe 0600 lista operación, lote/compromiso,
resultado y contactos. La salida estándar solo muestra cantidad y estado.

Operación contrasta cada caso con titular y establecimiento por el canal autorizado:
confirmar si una reserva o una oferta sigue acordada, si se canceló o retiró, y si
hubo una entrega o una incidencia que deba registrarse. No repetir automáticamente
entregas, cobros, códigos ni mensajes. Registrar una decisión por ID del informe:

```json
[{"id":"<id-del-caso>","action":"contacted","evidence":"Contacto y acuerdo verificados por Operación."}]
```

`action` admite `contacted`, `reconciled` o `no_effect`; cada caso requiere evidencia
concreta. Repetir con `--decisiones <archivo.json> --salida <otro-informe.json>`
verifica cobertura completa de decisiones. Sin resolver casos, sale con código 2 y
`readyToReopen=false`; con acceso/integridad incorrectos sale 1. El resultado expresa
la revisión registrada por Operación: el script no envía mensajes ni comprueba por sí
mismo que una persona recibió el aviso. Borrar informes y decisiones al terminar.

### Ensayo local

```bash
docker compose up -d --wait db
npm --prefix api run backup:rehearsal [-- --rondas N] [--anterior <ref>] [--conservar]
```

Siembra una base aislada con los casos de uso reales (por ronda: lotes con fotos, reservas
con código, entregas, oferta parcial, incidencias, chat y avisos), copia, borra una
miniatura en la fuente y comprueba que el manifiesto la marca como faltante, borra la
fuente, restaura, concilia y comprueba el release anterior. Luego inyecta fallas (objetos
borrados o alterados, otra clave de códigos y, en una copia de la base, una entrega
borrada, un código alterado, una restricción quitada o una secuencia reiniciada, entre
otras) y cada una debe hacer fallar su comprobación. Termina con código 1 si algo falla.
El informe queda en `api/.k053-results/<instante>-<commit>-ensayo/rehearsal.json`. Si el
proceso muere sin limpiar, se borran las bases `rescate_k053_*` con `dropdb` y el
worktree con `git worktree prune`.

### Limitaciones

- El ensayo real de recuperación en Railway debe acreditar el procedimiento completo y sus tiempos (#206).
- El diario identifica los efectos posteriores; su conciliación requiere intervención de Operación y contacto con los afectados.
- El bucket B2 borra todas las versiones al quitar una foto: la copia es el único
  respaldo de las fotos ([fotos](fotos.md#respaldo)).
- La copia no incluye `PICKUP_CODE_KEY`. Sin esa clave, los códigos vigentes restaurados
  no se pueden mostrar ni verificar.
- La copia usa el usuario de la base dentro de una transacción de solo lectura; no hay un
  rol de solo lectura.
- La API que levanta `backup:restore` escucha en todas las interfaces mientras dura la
  comprobación.

## Pruebas

| Comando | Qué comprueba |
| --- | --- |
| `npm --prefix api test` | Línea por solicitud con plantilla de la ruta, `(sin ruta)` y estado `null` si se corta; `request_failed` con el mismo identificador; salud con base disponible o no. |
| `npm --prefix api run db:test:operations:compose` | PostgreSQL real y procesos reales del worker: salud sin worker, latido, demora por cola, fallo real correlacionado con su solicitud, `kill -9` detectado como worker detenido, `ops:status` con un lote atrasado, lotes en error, el último intento en curso como pendiente y un aviso abandonado, recuperación al reiniciar, salud 503 sin base y con la base colgada (llamadas simultáneas y sucesivas con una sola conexión), `ops:status` sin base o con la base que deja de responder tras la salud, y base sin migrar. |
| `npm --prefix api run backup:rehearsal` | Ensayo de copia y restauración de punta a punta con datos ficticios ([ensayo local](#ensayo-local)). |
| `node --test api/test/encrypted-backups.test.mjs api/test/recovery-report.test.mjs` (tras build) | Cifrado, corrupción, extracción, subida verificada, rotación y decisiones completas. |
| `npm --prefix api run db:test:triage:compose` | Instantánea anterior a nueve operaciones reales; diario cifrado, contactos de cuentas nuevas, vínculos con lotes y ausencia de llamadas externas bajo locks. |
