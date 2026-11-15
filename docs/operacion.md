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
4. Revisar la antigüedad de la última copia en el registro de copias: su `createdAt` no
   supera 24 h ([copia y restauración](#copia-y-restauración-rnf08)).

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
lotes publicados en plazo, esas lecturas salen como `OMIT`. Fuera de la medición, el
worker completa un ciclo sin errores. El informe queda en `<copia>/restore-<base>.json`.

### Volver al release anterior

Como en [despliegue](despliegue.md#comprobación-y-recuperación), volver atrás no ejecuta
migraciones down. Con `--anterior <commit o deploy-<SHA>>`, la restauración comprueba que
las migraciones de ese release sean prefijo de las restauradas, lo compila en un worktree
temporal y levanta su API y su worker sobre otra copia de la base. El release anterior no
conoce las tablas nuevas: muestra los avisos ya generados, pero no las funciones que
agregaron.

### Procedimiento en producción

**Acceso.** El PostgreSQL de Railway no tiene TLS (`ssl=off`) ni TCP proxy. Se alcanza
con un túnel SSH de Railway, cifrado y sin cambiar el servicio. Requiere ser miembro del
proyecto, `railway login`, `railway link` al entorno `production` y una llave registrada
con `railway ssh keys add`:

```zsh
railway ssh config --service postgres --alias rescate-pg
ssh -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes -f -N \
  -L 127.0.0.1:15432:127.0.0.1:5432 rescate-pg   # cerrar al terminar
```

**Secretos.** Están en `railway variables --service postgres` y `--service api`. Se cargan
con `read -rs` (no quedan en el historial de zsh) y se borran al terminar:

```zsh
read -rs 'K053_SOURCE_DATABASE_URL?URL: '; echo; export K053_SOURCE_DATABASE_URL
read -rs 'PHOTO_S3_SECRET_ACCESS_KEY?Clave S3: '; echo; export PHOTO_S3_SECRET_ACCESS_KEY
read -rs 'K053_PICKUP_CODE_KEY?PICKUP_CODE_KEY: '; echo; export K053_PICKUP_CODE_KEY
# al terminar
unset K053_SOURCE_DATABASE_URL PHOTO_S3_SECRET_ACCESS_KEY K053_PICKUP_CODE_KEY PGPASSWORD K053_TARGET_DATABASE_URL
```

El checkout debe tener `api/migrations` igual al release vigente
(`git diff --quiet deploy-<SHA vigente> -- api/migrations`).

1. **Copiar** cada día y antes de cada demostración, sin desplegar mientras corre. La URL
   es `postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@127.0.0.1:15432/<POSTGRES_DB>`.
   Para las fotos conviene una application key de B2 de solo lectura.

   ```zsh
   export K053_SOURCE_PHOTO_STORAGE=s3 PHOTO_S3_ENDPOINT=… PHOTO_S3_REGION=… PHOTO_S3_BUCKET=… PHOTO_S3_ACCESS_KEY_ID=…
   npm --prefix api run backup:create
   ```
2. **Ensayar la restauración** con la ruta absoluta que imprime la copia:

   ```zsh
   npm --prefix api run backup:restore -- <copia> --manifiesto-sha256 <sha256> --anterior deploy-<SHA anterior> --borrar
   ```
3. **Cifrar y guardar.** Siete copias diarias en el equipo de Operación y una segunda en
   el del revisor, con la clave aparte. Registrar `createdAt`, el sha256 del manifiesto y
   el resultado del paso 2, y borrar la carpeta sin cifrar:

   ```zsh
   tar -C <padre> -cf - <copia> | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -out <copia>.tar.enc
   rm -rf <padre>/<copia>
   # para usarla: openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in <copia>.tar.enc | tar -C <nueva> -xf -
   ```
4. **Recuperar ante una pérdida real.** Pausar API y worker, crear un PostgreSQL nuevo
   con la imagen y el volumen de [despliegue](despliegue.md#servicios) y abrir un túnel
   a él. La imagen crea extensiones que el volcado vuelve a crear, así que la base se
   recrea desde `template0`:

   ```zsh
   export PGHOST=host.docker.internal PGPORT=15432 PGUSER=<POSTGRES_USER>   # PGPASSWORD con read -rs
   pg() { docker run --rm -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD postgis/postgis:16-3.5 "$@" }
   pg dropdb --force <POSTGRES_DB> && pg createdb --template=template0 <POSTGRES_DB>
   pg pg_restore -d <POSTGRES_DB> --no-owner --no-privileges --exit-on-error --single-transaction < <copia>/database.dump
   ```

   Subir las fotos que falten en el bucket desde `objects/lot-photos/`. Antes de reabrir,
   `backup:reconcile` debe pasar contra la base nueva y el bucket. Luego apuntar
   `DATABASE_URL` de API y worker a la base nueva, desplegar el release compatible y
   comprobar `test:deploy`.

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

- La copia no está programada ni se cifra o rota sola.
- La recuperación en Railway (paso 4) no está ensayada ni medida frente a 60 min.
- Las escrituras posteriores a la copia se pierden, y los registros no dicen de qué
  persona ni lote eran.
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
| `npm --prefix api run backup:rehearsal` | Ensayo de copia y restauración de punta a punta con datos ficticios ([abajo](#ensayo-local)). |
