# Entorno local y CI

Guía vigente para el árbol de trabajo K008/K010 (2026-09-21).
Compose levanta web, API, PostgreSQL/PostGIS y el worker. La API añade
[operaciones de lotes](lotes.md) y [fotos](fotos.md); requiere migraciones aplicadas.
Ver [backend](backend.md), [frontend](../web/README.md) y la evidencia histórica
[K006](evidencia/k006.md).

## Inicio desde un clon

Requisitos: Git, Docker Engine/Desktop activo y Docker Compose v2 con soporte
para `up --wait` (2.20 o posterior). En WSL, habilita la integración de la
distribución en Docker Desktop. No se necesita Node ni PostgreSQL en el host.
La imagen PostGIS elegida publica `amd64`; el servicio fija esa plataforma. En
equipos ARM, Docker debe tener emulación amd64 habilitada (puede ser más lenta).

```bash
git clone https://github.com/ClemoAcevedo/rescate.git
cd rescate
# Rama de integración vigente:
git switch development
cp .env.example .env
docker compose config --quiet
docker compose build
docker compose up -d --wait --wait-timeout 120
docker compose ps
```

Para revisar un PR, seleccionar su rama en lugar de `development`. `.env` está
ignorado por Git. Los ejemplos son credenciales públicas de desarrollo; los
puertos publicados escuchan solo en `127.0.0.1`. No usar este Compose en producción.

## Servicios y configuración

| Servicio | Propósito | Dirección predeterminada |
| --- | --- | --- |
| `web` | Vite, React y proxy `/api` | http://localhost:5173 |
| `api` | Express compilado; `GET /health` | http://localhost:3000/health |
| `db` | PostgreSQL 16 + PostGIS 3.5 | localhost:5432 |
| `worker` | Proceso Node independiente: registra vencimientos, valida fotos y limpia temporales | Sin puerto |

Variables del `.env` raíz (leídas por Compose):

| Variable | Valor de ejemplo | Uso |
| --- | --- | --- |
| `WEB_PORT` | `5173` | Puerto del host para web |
| `API_PORT` | `3000` | Puerto del host para API |
| `POSTGRES_PORT` | `5432` | Puerto del host para PostgreSQL |
| `POSTGRES_DB` | `rescate` | Base inicial |
| `POSTGRES_USER` | `rescate_dev` | Usuario de desarrollo |
| `POSTGRES_PASSWORD` | `rescate_dev_only` | Contraseña pública, solo local |
| `RESCATE_ALLOWED_ORIGINS` | `https://localhost:3443` | Orígenes HTTPS exactos para comandos |
| `CSRF_SIGNING_KEY` | Clave ficticia del ejemplo | Sustituir por 32 bytes aleatorios en base64 para uso real |
| `PICKUP_CODE_KEY` | Clave ficticia del ejemplo | Cifra los códigos de retiro; otra clave de 32 bytes para uso real |

Compose tiene los mismos valores por defecto que el ejemplo. Si un puerto está
ocupado, cámbialo en `.env` y ajusta las URLs de comprobación. Los puertos internos
siguen siendo 5173, 3000 y 5432. Las variables exportadas en la terminal tienen
precedencia sobre `.env`; evita sobrescribirlas accidentalmente.

Compose proporciona además `PORT=3000` a la API, `VITE_API_BASE_URL=/api` y
`API_PROXY_TARGET=http://api:3000` a Vite. `API_PROXY_TARGET` configura el proxy
del servidor, no se publica como variable del navegador. Fuera de Docker conserva
el destino `http://localhost:3000`; para otro destino, exporta esa variable antes
de `npm run dev`. `web/.env` solo es necesario al ejecutar Vite en el host.

API y worker comparten el Dockerfile de `api` y el volumen `photo_data`, donde
guardan las fotos con `PHOTO_STORAGE=local`. No hay montajes de código ni de
`node_modules`: después de cambiar código o dependencias, ejecuta
`docker compose up -d --build --wait`. Para recarga inmediata, usa los comandos
de desarrollo del README. Los contextos Docker excluyen `.env`, dependencias y
artefactos locales.

## Comprobaciones

Con los puertos por defecto:

```bash
curl --fail http://localhost:5173/
curl --fail http://localhost:3000/health
curl --fail http://localhost:5173/api/health
docker compose exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT current_database(), PostGIS_Version();"'
docker compose ps worker
docker compose logs worker
```

La web debe responder HTML y ambas rutas de salud deben responder
`{"status":"ok","database":"ok","worker":"ok"}`. Abre también http://localhost:5173/conexion y pulsa
**Comprobar conexión**. La consulta SQL verifica conexión TCP autenticada y debe
mostrar la base configurada y la versión de PostGIS.

`db`, `api` y `web` tienen healthchecks; web espera a que API esté saludable.
`/health` verifica el proceso HTTP y PostgreSQL ([operación](operacion.md)); la API espera al servicio db saludable.
Compose no aplica migraciones automáticamente.
El worker debe figurar `running` y registrar `Worker iniciado: vencimientos; validación y limpieza de fotos`.
Consulta PostgreSQL cada 2 s y limpia objetos cada minuto. Mientras falten las
migraciones registra `worker_error` y reintenta cada 5 s. Termina el lote, la foto o la tanda
de avisos en curso y sale con SIGTERM/SIGINT. Sin `DATABASE_URL` queda inactivo; con ella registra
[vencimientos](vencimientos.md) y genera los [avisos](avisos.md) del outbox, y con `PHOTO_STORAGE`
además procesa fotos.

## Persistencia y migraciones K002/K003

El volumen `postgres_data` conserva datos al recrear contenedores. La imagen
PostGIS habilita la extensión al inicializar `POSTGRES_DB`. Las tablas de Rescate
se crean con las [migraciones versionadas](migraciones.md), no al arrancar HTTP
ni Compose. El [modelo K003](modelo-inicial.md) describe las cinco entidades.

Desde el host, configurar `DATABASE_URL` en `api/.env` o en el entorno con el
usuario, base y puerto de Compose. Ejecutar `npm run db:migrate` desde `api/`.
El destino del host es `127.0.0.1` y el valor de `POSTGRES_PORT`; dentro de Compose,
`db:5432`. API y worker reciben esa URL y consultan PostgreSQL.
K008 exige `users` vacío al migrar: nunca borrar datos automáticamente para eludir
la precondición. Ver [operación y HTTPS K008](k008-identidad.md).

Los comandos `db:migrate`, `db:create`, `db:rollback` y `db:test` cargan
`api/.env` mediante Node; una variable del entorno tiene prioridad.
`db:test:compose` obtiene la conexión
del servicio `db`, crea una base exclusiva desde template0 y ejecuta la prueba
K003 con rollback/reaplicación. Conserva esa base; no prueba sobre la de desarrollo.
Seguir los prerrequisitos de la [guía](migraciones.md#prueba-actual-de-k003).

Si cambia usuario/base/contraseña con un volumen existente, PostgreSQL conserva
los valores originales. No reinicializar datos que deban conservarse.

## Detener y limpiar

```bash
# Detener conservando contenedores y datos:
docker compose stop
# Eliminar contenedores y red, conservando datos:
docker compose down
# SOLO si quieres borrar todos los datos locales de este Compose:
docker compose down --volumes --remove-orphans
```

No hace falta una limpieza global de Docker. Para diagnosticar:
`docker compose logs --no-color` y `docker compose ps -a`.

## Los mismos checks que CI

En el host, usa Node 24.14.0 y npm. Desde la raíz:

```bash
npm --prefix web ci
npm --prefix web run typecheck
npm --prefix web run lint
npm --prefix web run build
npm --prefix api ci
npm --prefix api run api:contract:check
npm --prefix api run typecheck
npm --prefix api test
npm --prefix api run build
```

`.github/workflows/ci.yml` se activa en todos los PR y en pushes a `main` y
`development`. Valida el origen `development` de los PR a `main`, ejecuta web y
API en paralelo y después, también en paralelo, Compose y los recorridos de
navegador. Un push nuevo a un PR cancela la ejecución anterior de ese PR; los push a
`main` y `development` nunca se cancelan:

- `web`: instalación con lockfile, TypeScript, lint y build en pasos separados.
  Actualmente no existen tests web; no se oculta esa ausencia con `--if-present`.
- `api`: instalación con lockfile, validación OpenAPI, tipos HTTP generados, TypeScript, tests de salud, identidad, seguridad y lotes y build de
  API/worker en pasos separados. Usa `node:test` y el `tsx` ya existente.
- `compose`: valida configuración, construye, levanta con espera, consulta API,
  web/proxy y PostGIS, prueba migraciones, concurrencia K010, Infrastructure K008, fotos K014 con el worker real, reservas K022/K025, cola K027, vencimientos K028 con procesos reales del worker, avisos, seguridad, panel y operación; verifica worker y siempre recoge logs y limpia.
- `browser`: levanta solo el PostgreSQL de Compose, instala Chromium (en caché por
  lockfile, con tres intentos de 3 minutos porque la descarga a veces se cuelga) y
  ejecuta la autenticación HTTPS con reinicio de API y `test:web:compose`. No es
  un check obligatorio mientras no se agregue a la protección de ramas.

El test usa un puerto efímero, no requiere PostgreSQL y cierra el servidor incluso
ante una aserción fallida. Un fallo de `npm test` interrumpe el job API; no hay
`continue-on-error`. Los comandos del job Compose están en el workflow.

## Revisión de PR con Gemini

[Gemini PR Review](../.github/workflows/gemini-review.yml) revisa PR abiertos y
nuevos commits con `gemini-3.5-flash-lite`. Publica una revisión de tipo comentario
mediante `github-actions[bot]`, con hallazgos en español y enlaces a líneas del
commit revisado. Complementa la revisión de otro integrante exigida por la
protección de ramas.

### Configuración

1. Crear una clave de Gemini API en [Google AI Studio](https://aistudio.google.com/api-keys)
   en un proyecto con la capa gratuita disponible.
2. Guardarla como `GEMINI_API_KEY` en **Settings → Secrets and variables → Actions**
   del repositorio. `GITHUB_TOKEN` lo proporciona Actions con permisos de lectura
   de contenido y escritura de revisiones.
3. Abrir un PR listo para revisión desde una rama del mismo repositorio o subir
   un commit. Los borradores, forks y pushes de Dependabot quedan excluidos del
   job que usa el secreto.

El reviewer usa la [API de Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite),
que ofrece entrada y salida gratuitas dentro de la cuota del proyecto. Consultar los
[límites efectivos en AI Studio](https://ai.google.dev/gemini-api/docs/rate-limits).
La capa gratuita permite a Google usar el contenido enviado para mejorar sus
productos; las condiciones de pago son distintas.

### Alcance y diagnóstico

El script envía las reglas de `AGENTS.md`, las
[instrucciones compartidas](../.github/review-instructions.md), el título,
la descripción y los diffs del PR. Consulta Gemini sin herramientas ni ejecución
del código recibido. Ante un `503` o un tiempo de espera agotado, reintenta hasta
dos veces, esperando 10 y 20 segundos y comprobando que el SHA sigue vigente.
Cada intento tiene un límite de 120 segundos; el job completo, ocho minutos.
Los errores de clave, cuota y formato no se reintentan automáticamente.
El presupuesto de diffs es de
60 000 caracteres: omite archivos completos que no caben o no tienen patch y
los identifica en la revisión como cobertura parcial. GitHub puede limitar el
patch de archivos grandes; el reviewer solo conoce los fragmentos recibidos.

El workflow cancela la ejecución anterior al llegar otro commit y comprueba el
SHA antes de publicar. Reejecutar un SHA que ya tiene revisión no consume otra
consulta. Un resultado sin hallazgos solo se refiere a los diffs enviados.

Si se agotan los reintentos, falta la clave, Gemini rechaza el acceso, se agota la cuota (`429`) o devuelve
una respuesta incompleta o ubicaciones inválidas, el job falla con un mensaje en
Actions y no publica una revisión. Corregir la configuración o esperar la
renovación de cuota y usar **Re-run failed jobs** en la ejecución de **Gemini PR
Review**. Este job es independiente del CI del producto.

Para comprobarlo, buscar una revisión publicada por `github-actions[bot]` con el
título **Revisión de Gemini 3.5 Flash-Lite** y el SHA vigente. Un job verde por sí solo
no acredita una revisión: también puede haber omitido un commit reemplazado.
Las pruebas del reviewer se ejecutan sin claves con:

```bash
node --test .github/scripts/gemini-review.test.mjs
```

Las instrucciones de Copilot remiten al mismo archivo compartido. Su regla de
revisión sigue dependiendo del acceso y la cuota de Copilot; Gemini funciona
mediante su propio workflow.

## Evidencia y aceptación en el PR

Consulta [el registro de verificación K006](evidencia/k006.md), con resultados
locales, limitaciones y la prueba controlada de fallo/restauración.

Después de abrir el PR, comprobar que aparecen los tres jobs y que pasan. La
demostración de fallo de K006 es evidencia histórica, no un paso de cada cambio.
Solo para reproducir esa demostración, en una rama/PR temporal cambia la expectativa HTTP
de 200 a 503 en `api/test/health.test.ts`, comprueba que falla el paso `Tests` del
job API y restaura el test inmediatamente. Conserva enlaces a ambas ejecuciones
(roja y verde) en el PR. No dejar el test roto en la rama final.

La configuración de checks obligatorios en protección de ramas requiere acceso
al repositorio en GitHub y no forma parte de los archivos del workflow.

La producción usa el [workflow Railway/Vercel](despliegue.md) después de que este
CI termine correctamente sobre `main`.
