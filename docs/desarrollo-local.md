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
  lockfile) con [`install-chromium.sh`](../.github/scripts/install-chromium.sh), que da
  timeouts de red a apt y reintenta tras terminar un apt-get colgado, y
  ejecuta la autenticación HTTPS con reinicio de API y `test:web:compose`. No es
  un check obligatorio mientras no se agregue a la protección de ramas.

El test usa un puerto efímero, no requiere PostgreSQL y cierra el servidor incluso
ante una aserción fallida. Un fallo de `npm test` interrumpe el job API; no hay
`continue-on-error`. Los comandos del job Compose están en el workflow.

### Cobertura de la API

```bash
npm --prefix api run test:coverage
# Con el servicio db de Compose levantado:
npm --prefix api run test:coverage:compose
```

El primero mide las pruebas unitarias con la cobertura de `node:test`. El segundo ejecuta
uno a uno los envoltorios del job `compose` de CI y mide también la API y el worker que
esos envoltorios lanzan. Cada corrida deja en `api/coverage/` (ignorado por git) su lcov,
su salida y su código de salida. [`coverage-summary.mjs`](../api/scripts/coverage-summary.mjs)
escribe `summary.md` y `summary.json` y termina con el código del runner. Las cifras van en
la descripción del PR. E1 no fija una meta de cobertura.

Para leer el resumen:

- La cifra de líneas que se cita incluye los archivos con código que ninguna prueba cargó.
  «Solo cargados» equivale al total de Node, que los omite y sobrestima.
- `--enable-source-maps` es obligatorio. Sin él Node asigna las líneas del JavaScript
  generado al TypeScript y las cifras salen falsas. El resumen guarda el comando de cada
  corrida y la marca como no válida si falta.
- Las unitarias cargan `src` con `tsx` y la integración carga `dist`, así que ramas y
  funciones no se suman entre corridas: solo se unen las líneas. Las ramas salen infladas
  porque V8 no informa las de funciones que nunca se ejecutaron.
- Una corrida con pruebas fallidas deja un lcov parcial; el resumen lista los envoltorios
  que corrieron y las pruebas que fallaron. La instrumentación vuelve más lentos la API y
  el worker: un fallo por plazo se confirma repitiendo ese envoltorio sin cobertura.
- No se miden `web/` (no tiene pruebas unitarias y Playwright no instrumenta el
  navegador), los contenedores de Compose, los procesos terminados con `SIGKILL` ni los
  scripts fuera del job `compose`. La carga y la integridad se miden sin cobertura,
  porque la instrumentación cambia las latencias.

## Revisión automática de PR

[Gemini PR Review](../.github/workflows/gemini-review.yml) revisa PR abiertos y
nuevos commits con `gemini-3.5-flash-lite` como proveedor principal y OpenRouter
Free como respaldo. Publica una revisión de tipo comentario
mediante `github-actions[bot]`, con hallazgos en español y enlaces a líneas del
commit revisado. Es informativa, no aprueba el PR ni es un check obligatorio para
integrar. La protección de ramas exige Pull Request y CI, sin exigir aprobación
humana.

### Configuración

1. Crear una clave de Gemini API en [Google AI Studio](https://aistudio.google.com/api-keys)
   en un proyecto con la capa gratuita disponible y guardarla como `GEMINI_API_KEY`
   en **Settings → Secrets and variables → Actions** del repositorio.
2. Crear una clave en [OpenRouter](https://openrouter.ai/keys) y guardarla como
   `OPENROUTER_API_KEY` en el mismo lugar. Gemini se intenta primero; OpenRouter
   se usa si Gemini falla o su respuesta no supera las validaciones. El modelo
   `openrouter/free` selecciona un modelo gratuito compatible disponible. Sus
   límites y disponibilidad dependen de OpenRouter y del proveedor seleccionado.
   Si solo existe la clave de OpenRouter, también puede hacer la revisión primaria.
3. `GITHUB_TOKEN` lo proporciona Actions con permisos de lectura de contenido y
   escritura de revisiones. Abrir un PR listo para revisión desde una rama del
   mismo repositorio o subir un commit. Los borradores, forks y pushes de
   Dependabot quedan excluidos del job que usa los secretos.

El reviewer usa la [API de Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite),
que ofrece entrada y salida gratuitas dentro de la cuota del proyecto. Consultar los
[límites efectivos en AI Studio](https://ai.google.dev/gemini-api/docs/rate-limits).
La capa gratuita permite a Google usar el contenido enviado para mejorar sus
productos; las condiciones de pago son distintas. Cuando se activa OpenRouter,
el diff y el contexto enviados también se procesan por OpenRouter y el proveedor
gratuito que seleccione; sus políticas de retención pueden variar.

### Alcance y diagnóstico

El job ejecuta el reviewer y lee `AGENTS.md` y las
[instrucciones compartidas](../.github/review-instructions.md) desde el **base SHA**.
Lee los objetos Git del PR como datos: no instala sus paquetes ni ejecuta su código.
Una modificación del reviewer se activa cuando llega a la rama destino; su propio PR
se revisa con la versión que ya existe en esa base.

El [planificador](../.github/scripts/review-context.mjs) recupera el diff completo
desde el merge-base hasta el HEAD, sin depender del patch recortado de GitHub.
Prioriza código de producción y reparte todos los diffs de texto en hasta 16 lotes
de 60 000 caracteres JSON cada uno. Divide también bloques grandes conservando los
números de línea de ambos lados. Binarios, cambios sin diff de texto, líneas que no
caben y límites excedidos quedan enumerados como pendientes; no producen cobertura
completa.

Cada lote añade hasta 30 000 caracteres de extractos numerados del HEAD: versiones
de `package.json`, configuración TypeScript, imports relativos directos y documentación
del área modificada. Es contexto selectivo, no resolución completa de dependencias:
los archivos recortados se identifican. El contrato HTTP modificado puede aportar
extractos adicionales cuando cabe. El título y la descripción del autor son contexto,
no evidencia de corrección ni instrucciones para el modelo.

Gemini usa [razonamiento alto](https://ai.google.dev/gemini-api/docs/thinking) y
salida estructurada. Debe enumerar todas las rutas recibidas y cada hallazgo necesita
ubicación cambiada (`RIGHT` o `LEFT`), caso concreto, impacto, corrección y una cita
exacta de código visible, con confianza mínima 0,85. Una segunda consulta intenta
refutar cada candidato: confirmarlo o descartarlo requiere evidencia visible y
confianza mínima 0,90. Un candidato sin verificar deja la revisión incompleta.
Estas validaciones no demuestran que el modelo haya encontrado todos los bugs.

Ante HTTP 500/502/503/504 o fallos de conexión/timeout, Gemini reintenta hasta cuatro
veces, esperando 10, 20, 40 y 80 segundos. Si Gemini falla, devuelve formato inválido
o cobertura incompleta, el reviewer intenta OpenRouter. Cada intento dura hasta 120
segundos; la revisión tiene 20 minutos de presupuesto total y el job 25. En particular,
`401` indica una clave ausente o inválida; `429` indica límite de uso; `503` indica que
el servicio está temporalmente sobrecargado o caído. El bot comprueba HEAD, base y
estado del PR antes de cada consulta, reintento y publicación; descarta resultados
obsoletos.

Una revisión incompleta aparece advertida al principio del comentario y deja el
job fallido, conservando los hallazgos confirmados y la lista de pendientes. Se
puede repetir con **Re-run failed jobs** sobre el mismo HEAD y base después de
resolver la causa. Solo una revisión completa de esta versión y de ambos SHA
suprime consultas duplicadas. Si falta la clave o no se puede preparar el diff,
el error aparece en Actions antes de consultar el modelo.

El artefacto `gemini-review-RUN-ATTEMPT` conserva durante 14 días `review-result.json`
con cobertura y decisiones, y `review-usage.json` con los tokens informados por los
proveedores, sin prompts ni credenciales. El consumo se guarda antes y después de
cada llamada, también si su respuesta es inválida o el SHA cambia. `unknownRequests`
indica consultas cuyo consumo no fue informado: el total conocido no equivale a una factura.
Los logs solo muestran conteos y diagnósticos. El número de consultas crece con los
lotes, hallazgos y reintentos; los tests locales no consumen API. Este job es
independiente del CI del producto y no aprueba ni integra PRs.

Para comprobarlo, buscar una revisión publicada por `github-actions[bot]` con el
título **Revisión de Gemini 3.5 Flash-Lite** y el SHA vigente. Un job verde por sí solo
no acredita una revisión: también puede haber omitido un commit reemplazado.
Las pruebas del reviewer se ejecutan sin claves con:

```bash
node --test --test-isolation=none .github/scripts/*.test.mjs
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
