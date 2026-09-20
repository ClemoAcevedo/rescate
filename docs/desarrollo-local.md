# Entorno local y CI — K006

Referencia: E2 / RNF07. Esta infraestructura levanta la web existente, `/health`,
PostgreSQL con PostGIS y un proceso worker inactivo. No implementa migraciones,
modelos, autenticación, reservas ni vencimientos.

## Inicio desde un clon

Requisitos: Git, Docker Engine/Desktop activo y Docker Compose v2 con soporte
para `up --wait` (2.20 o posterior). En WSL, habilita la integración de la
distribución en Docker Desktop. No se necesita Node ni PostgreSQL en el host.
La imagen PostGIS elegida publica `amd64`; el servicio fija esa plataforma. En
equipos ARM, Docker debe tener emulación amd64 habilitada (puede ser más lenta).

```bash
git clone https://github.com/ClemoAcevedo/rescate.git
cd rescate
# Antes del merge, seleccionar la rama del PR:
git switch chore/k006-docker-ci
cp .env.example .env
docker compose config --quiet
docker compose build
docker compose up -d --wait --wait-timeout 120
docker compose ps
```

Después del merge, usa la rama de integración que incluya K006. `.env` está
ignorado por Git. Los ejemplos son credenciales públicas de desarrollo; los
puertos publicados escuchan solo en `127.0.0.1`. No usar este Compose en producción.

## Servicios y configuración

| Servicio | Propósito | Dirección predeterminada |
| --- | --- | --- |
| `web` | Vite, React y proxy `/api` | http://localhost:5173 |
| `api` | Express compilado; `GET /health` | http://localhost:3000/health |
| `db` | PostgreSQL 16 + PostGIS 3.5 | localhost:5432 |
| `worker` | Proceso Node independiente, infraestructura inicial | Sin puerto |

Variables del `.env` raíz (leídas por Compose):

| Variable | Valor de ejemplo | Uso |
| --- | --- | --- |
| `WEB_PORT` | `5173` | Puerto del host para web |
| `API_PORT` | `3000` | Puerto del host para API |
| `POSTGRES_PORT` | `5432` | Puerto del host para PostgreSQL |
| `POSTGRES_DB` | `rescate` | Base inicial |
| `POSTGRES_USER` | `rescate_dev` | Usuario de desarrollo |
| `POSTGRES_PASSWORD` | `rescate_dev_only` | Contraseña pública, solo local |

Compose tiene los mismos valores por defecto que el ejemplo. Si un puerto está
ocupado, cámbialo en `.env` y ajusta las URLs de comprobación. Los puertos internos
siguen siendo 5173, 3000 y 5432. Las variables exportadas en la terminal tienen
precedencia sobre `.env`; evita sobrescribirlas accidentalmente.

Compose proporciona además `PORT=3000` a la API, `VITE_API_BASE_URL=/api` y
`API_PROXY_TARGET=http://api:3000` a Vite. `API_PROXY_TARGET` configura el proxy
del servidor, no se publica como variable del navegador. Fuera de Docker conserva
el destino `http://localhost:3000`; para otro destino, exporta esa variable antes
de `npm run dev`. `web/.env` solo es necesario al ejecutar Vite en el host.

API y worker comparten el Dockerfile de `api`. No hay montajes de código ni de
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
`{"status":"ok"}`. Abre también http://localhost:5173/conexion y pulsa
**Comprobar conexión**. La consulta SQL verifica conexión TCP autenticada y debe
mostrar la base configurada y la versión de PostGIS.

`db`, `api` y `web` tienen healthchecks; web espera a que API esté saludable.
`/health` verifica únicamente el proceso HTTP, no la base. API y worker todavía
no consultan PostgreSQL y no tienen una dependencia de inicio artificial con él.
El worker debe figurar `running` y registrar `Worker K006 iniciado`.
Permanece inactivo con un temporizador de 24 horas sin tareas, polling ni logs
periódicos, y termina limpiamente con SIGTERM/SIGINT. No tiene healthcheck de
trabajos porque todavía no procesa ninguno.

## Persistencia y futura integración de K002

El volumen nombrado `postgres_data` conserva los datos al recrear contenedores.
La imagen [PostGIS](https://github.com/postgis/docker-postgis) habilita PostGIS en
`POSTGRES_DB` durante la inicialización de un volumen vacío. No hay SQL de dominio,
gestor de migraciones ni ejecución automática de migraciones en K006.

Cuando K002 esté integrada, su gestor podrá conectarse con estos datos:

- Desde el host: `127.0.0.1`, puerto `POSTGRES_PORT`.
- Desde un servicio de Compose: host `db`, puerto `5432`.
- Base, usuario y contraseña: los valores `POSTGRES_*` de `.env`.

Ejemplo con los valores de desarrollo:
`postgresql://rescate_dev:rescate_dev_only@localhost:5432/rescate`.
K002 decidirá el nombre de la variable de conexión y sus comandos; K006 no los
presupone ni añade un cliente de base de datos. Si cambia usuario/base/contraseña
con un volumen ya inicializado, PostgreSQL conserva los valores originales:
usa los originales o reinicializa explícitamente si los datos son descartables.

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
npm --prefix api run typecheck
npm --prefix api test
npm --prefix api run build
```

`.github/workflows/ci.yml` se activa en todos los PR y en pushes a `main` y
`development`. Tiene tres jobs independientes:

- `web`: instalación con lockfile, TypeScript, lint y build en pasos separados.
  Actualmente no existen tests web; no se oculta esa ausencia con `--if-present`.
- `api`: instalación con lockfile, TypeScript, test HTTP de salud y build de
  API/worker en pasos separados. Usa `node:test` y el `tsx` ya existente.
- `compose`: valida configuración, construye, levanta con espera, consulta API,
  web/proxy y PostGIS, verifica worker y siempre recoge logs y limpia.

El test usa un puerto efímero, no requiere PostgreSQL y cierra el servidor incluso
ante una aserción fallida. Un fallo de `npm test` interrumpe el job API; no hay
`continue-on-error`. Los comandos del job Compose están en el workflow.

## Evidencia y aceptación en el PR

Consulta [el registro de verificación K006](verificacion-k006.md), con resultados
locales, limitaciones y la prueba controlada de fallo/restauración.

Después de abrir el PR, comprobar que aparecen los tres jobs y que pasan. Para
demostrar el fallo remoto, en una rama/PR temporal cambia la expectativa HTTP
de 200 a 503 en `api/test/health.test.ts`, comprueba que falla el paso `Tests` del
job API y restaura el test inmediatamente. Conserva enlaces a ambas ejecuciones
(roja y verde) en el PR. No dejar el test roto en la rama final.

La configuración de checks obligatorios en protección de ramas requiere acceso
al repositorio en GitHub y no forma parte de los archivos del workflow.
