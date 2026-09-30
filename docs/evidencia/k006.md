# Verificación K006 — 2026-09-20

Rama: `chore/k006-docker-ci`. Base inspeccionada: `133be91`.
El árbol estaba limpio. No había Dockerfiles, Compose, workflow ni tests.
Se revisaron archivos versionados, configuración, lockfiles, código web/API,
documentación de contratos y plantilla del PR. No se encontraron AGENTS.md
aplicables. No se implementó K002/K003 ni se hicieron commits, push o merge.

## Resultados

La tabla reúne las comprobaciones iniciales del agente y la validación manual
posterior ejecutada y confirmada por el usuario en WSL2 con Docker Desktop.
Los resultados de contenedores provienen de esa validación manual; no de una
nueva ejecución del agente.

| Comprobación | Resultado real |
| --- | --- |
| Node / npm | 24.14.0 / 11.19.0 |
| npm ci API y web | OK, lockfiles sin cambios, auditoría de instalación: 0 vulnerabilidades |
| TypeScript API / web | OK |
| Lint web | OK |
| Build API / worker | OK |
| Build web | OK, Vite 8.3.0, 34 módulos |
| Test HTTP API | OK, 1 test |
| Test deliberadamente roto | Falló con código 1 y aserción 200 !== 503 |
| Test restaurado | OK, código 0 |
| Configuración Compose | OK, ejecutable oficial Compose v2.39.4 en /tmp |
| Workflow | OK, actionlint 1.7.7 sin hallazgos |
| API local compilada | HTTP 200, {"status":"ok"} en puerto 33006 |
| Web local Vite | HTTP 200 en puerto 5176 |
| Proxy web → API | {"status":"ok"} en /api/health |
| Worker local compilado | Inicia, permanece activo y termina con código 0 por SIGTERM |
| Docker / Compose en WSL2 con Docker Desktop | OK, Docker 29.7.2 / Compose v5.4.0; validación manual del usuario |
| Build de imágenes | OK, api, web y worker; validación manual del usuario |
| Arranque Compose | OK, db, api, web y worker; validación manual del usuario |
| Healthchecks en contenedores | api, db y web healthy; worker permanece ejecutándose |
| API / web / proxy en contenedores | HTTP 200 en los tres endpoints; detalles abajo |
| PostgreSQL / PostGIS en contenedor | Conexión OK; PostGIS 3.5 con USE_GEOS=1, USE_PROJ=1 y USE_STATS=1 |
| Persistencia del volumen | OK, dato conservado tras down / up sin eliminar volúmenes; tabla de prueba eliminada después |
| Git diff --check | OK |
| Exclusiones Git | .env, node_modules y dist siguen ignorados |
| GitHub Actions remoto | No ejecutado; requiere PR |

En la sesión inicial del agente, los procesos locales se detuvieron al terminar
y no se crearon volúmenes ni .env local. Los binarios de validación y salidas
transitorias quedaron en /tmp, fuera del repositorio. La validación manual
posterior sí comprobó el volumen de PostgreSQL, como se detalla a continuación.

## Validación manual en WSL2 con Docker Desktop

Evidencia ejecutada y confirmada por el usuario. Docker 29.7.2 y Docker Compose
v5.4.0 estaban operativos. Esta comprobación resuelve los bloqueos de validación
Docker de la sesión inicial; las incidencias históricas se conservan abajo.

- `docker compose build` construyó correctamente `api`, `web` y `worker`.
- `docker compose up -d` levantó `db`, `api`, `web` y `worker`.
- `api`, `db` y `web` llegaron a `healthy`; `worker` permaneció ejecutándose.

| Solicitud | Respuesta confirmada |
| --- | --- |
| GET http://localhost:3000/health | HTTP 200, `{"status":"ok"}` |
| GET http://localhost:5173 | HTTP 200 |
| GET http://localhost:5173/api/health | HTTP 200, `{"status":"ok"}`; proxy web → API validado |

PostgreSQL aceptó conexión con `POSTGRES_USER=rescate_dev` y
`POSTGRES_DB=rescate`. `SELECT PostGIS_Version()` devolvió PostGIS 3.5 con
`USE_GEOS=1`, `USE_PROJ=1` y `USE_STATS=1`.

El worker registró:

```text
Worker K006 iniciado: infraestructura inactiva, sin trabajos configurados
```

La persistencia se comprobó con esta secuencia:

1. Se creó una tabla de prueba llamada `k006_persistence_test` y se insertó
   el valor `(1, 'ok')`.
2. Se ejecutó `docker compose down` sin eliminar volúmenes.
3. Se ejecutó nuevamente `docker compose up -d`.
4. `k006_persistence_test` continuó conteniendo `(1, 'ok')`, verificando que
   los datos persistieron al eliminar y recrear los contenedores.
5. La tabla de prueba fue eliminada después de la comprobación.

Esta evidencia valida el entorno Docker local. No acredita una ejecución de
GitHub Actions ni una verificación independiente por un segundo integrante.

## Fallo controlado y restauración

Se ejecutó exactamente `npm test` en `api`, como en el workflow.
Se cambió solo `assert.equal(response.status, 200)` por
`assert.equal(response.status, 503)`. La restauración se realizó en un bloque
`finally`, antes de volver a ejecutar el test.

### Antes — código 0

```text
> api@1.0.0 test
> node --import tsx --test test/*.test.ts

✔ GET /health responde 200 con el estado de la API (35.240171ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 169.386095
```

### Fallo deliberado — código 1

```text
> api@1.0.0 test
> node --import tsx --test test/*.test.ts

✖ GET /health responde 200 con el estado de la API (35.53702ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 221.784986

✖ failing tests:

test at test/health.test.ts:1:129
✖ GET /health responde 200 con el estado de la API (35.53702ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  200 !== 503
  
      at TestContext.<anonymous> (/home/clemoacevedo/university/SW/rescate/api/test/health.test.ts:14:12)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1125:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:358:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 200,
    expected: 503,
    operator: 'strictEqual',
    diff: 'simple'
  }
```

### Restaurado — código 0

```text
> api@1.0.0 test
> node --import tsx --test test/*.test.ts

✔ GET /health responde 200 con el estado de la API (33.402595ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 166.754858
```

Esto demuestra el código de salida local que consume el paso `Tests`; no es
evidencia de una ejecución remota en GitHub.

## Incidencias históricas de la sesión inicial del agente

Los bloqueos Docker descritos aquí corresponden al entorno inicial del agente;
la validación manual posterior del usuario completó esas comprobaciones.

- `docker --version` y `docker compose version` encontraron el aviso de WSL:
  Docker no está disponible en esta distribución.
- Se descargó Compose oficial a /tmp para validar configuración sin daemon.
  `build` falló con
  `fork/exec /usr/local/lib/docker/cli-plugins/docker-buildx: no such file or directory`.
- Los intentos de acceso al socket dentro del sandbox respondieron permiso
  denegado. Se reintentó el arranque con permiso fuera del sandbox y respondió
  `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`.
- El runner mostró fallos genéricos `test failed` en algunos intentos dentro
  del sandbox, especialmente al redirigir/capturar stdout. No hubo una aserción
  de aplicación en esas salidas. El test pasó sin cambios en ejecución directa,
  con reporter TAP y fuera del sandbox. No se determinó la causa exacta; no se
  ocultó el fallo ni se añadieron retries al CI. La secuencia de aceptación
  registrada arriba sí mostró el fallo de aserción esperado y restauración.
- Vite encontró `listen EPERM` dentro del sandbox. Se repitió fuera de él con
  permiso y funcionó. Los curl desde el sandbox tampoco alcanzaron esos
  servidores; fuera de él pasaron los tres.
- La consulta de PyYAML falló porque no está instalado; se usaron los validadores
  oficiales Compose y actionlint, no una validación YAML aproximada.
- `npm ci` de API avisó de un install script de esbuild no cubierto por
  allowScripts en npm 11.19; instalación, tsx y build completaron correctamente.
- Un comando exploratorio `node --test -e 'console.log(1)'` devolvió código 9:
  Node no permite combinar --test con --eval. No es un check de la aplicación.

## Pendientes para aceptar K006

1. Ejecutar realmente el workflow en GitHub Actions al abrir el PR y comprobar
   los tres jobs (web, api, compose), enlazando el run.
2. Demostrar remotamente el fallo ante un test roto y su restauración en una
   rama/PR de prueba, como indica la guía. No mantener una expectativa rota en
   el PR final; conservar enlaces a las ejecuciones fallida y exitosa.
3. Obtener la verificación de un segundo integrante desde un clon limpio,
   siguiendo exclusivamente la documentación.

## Decisiones para revisión

- Revisar protección de ramas si se quiere exigir los checks al merge.
- En equipos ARM, confirmar la emulación de la imagen amd64; la validación
  manual informada no especifica esa arquitectura.
- Compose de desarrollo: Vite expuesto solo a loopback; no es un despliegue.
- Node fijado a 24.14.0; PostGIS 16-3.5 es un tag mantenido, no un digest
  inmutable. Los lockfiles fijan las dependencias npm existentes.
- PostGIS usa su inicialización estándar, sin SQL de dominio ni migraciones.
- API y worker no acceden a DB; el contrato de conexión lo definirá K002.
- El worker es explícitamente inactivo, sin trabajos ni consultas.
- No hay recarga automática en contenedores: reconstruir al cambiar código.
- No se añadieron dependencias, ni se modificaron lockfiles o .gitignore.

## Inventario de comandos ejecutados

Este inventario corresponde a la sesión inicial del agente. Los comandos y
resultados manuales informados posteriormente por el usuario figuran en la
sección de validación en WSL2. Repeticiones agrupadas; salvo donde se indica,
desde la raíz. Las ediciones se hicieron con `apply_patch`. No se ejecutaron
comandos Git de escritura.

### Inspección

```bash
pwd
git status --short
git status --porcelain=v1
git branch --show-current
git log -5 --oneline
git ls-files
git remote -v
ls -la
ls -la .github api web
rg --files -g '!package-lock.json' -g '!node_modules' -g '!dist' -g '!\.git' -g '!*lock*'
rg --files -g AGENTS.md -g '!node_modules' /home/clemoacevedo/university /home/clemoacevedo/.codex 2>/dev/null
for p in /AGENTS.md /home/AGENTS.md /home/clemoacevedo/AGENTS.md /home/clemoacevedo/university/AGENTS.md /home/clemoacevedo/university/SW/AGENTS.md; do if test -f "$p"; then cat "$p"; fi; done
find . -name AGENTS.md -not -path '*/node_modules/*' -not -path './.git/*'
find .agents .codex -type f -maxdepth 2 -print
cat .agents/* .codex/* 2>/dev/null
cat README.md docs/README.md api/package.json api/tsconfig.json api/src/index.ts web/package.json web/vite.config.ts web/eslint.config.js .gitignore web/.env.example
cat .github/pull_request_template.md docs/contrato-api.md web/src/services/README.md web/tsconfig*.json
rg -n '.' web/src api/src web/index.html
cat web/src/services/http-client.ts web/src/main.tsx web/src/pages/LotsPage.tsx
rg -n '"engines"|"node"|"lockfileVersion"|"resolved"' api/package-lock.json web/package-lock.json
node --version
npm --version
docker --version
docker compose version
command -v actionlint
command -v ruby
command -v python3
command -v go
python3 -c 'import yaml; print(yaml.__version__)'
ls -l /var/run/docker.sock
```

Las búsquedas sin coincidencias devolvieron código 1; `.agents/*` no tenía
coincidencias. Eso no indica un fallo del proyecto.

### Dependencias y checks

```bash
# En api/ y web/, respectivamente:
npm ci
# En web/:
npm run typecheck && npm run lint && npm run build
# En api/:
npm run typecheck && npm test && npm run build
npm test
npm run build
node --import tsx --test --test-isolation=none --test-reporter=tap test/health.test.ts
node --import tsx --test --test-reporter=tap test/health.test.ts
node --import tsx test/health.test.ts
node --test -e 'console.log(1)'
```

`npm test` se repitió también con permiso fuera del sandbox (OK).
Las variantes con reporter fueron diagnóstico, no cambios al script de CI.

### Validación Docker / workflow

```bash
wget -q -O /tmp/k006-compose https://github.com/docker/compose/releases/download/v2.39.4/docker-compose-linux-x86_64
wget -q -O /tmp/k006-actionlint.tar.gz https://github.com/rhysd/actionlint/releases/download/v1.7.7/actionlint_1.7.7_linux_amd64.tar.gz
chmod +x /tmp/k006-compose
tar -xzf /tmp/k006-actionlint.tar.gz -C /tmp actionlint
/tmp/actionlint -version
/tmp/actionlint .github/workflows/ci.yml
/tmp/k006-compose version
/tmp/k006-compose --env-file .env.example config --quiet
mkdir -p /tmp/k006-evidence
/tmp/k006-compose --env-file .env.example config --format json > /tmp/k006-evidence/compose.json
/tmp/k006-compose --env-file .env.example build
/tmp/k006-compose --env-file .env.example up -d --wait --wait-timeout 120
/tmp/k006-compose ps
/tmp/k006-compose exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT current_database(), PostGIS_Version();"'
/tmp/k006-compose logs worker
```

En esa sesión inicial, el comando `up` se repitió fuera del sandbox y confirmó
que no había daemon disponible para el agente.
El ejecutable Compose independiente permite validar la configuración aunque
el comando `docker compose` del host no esté disponible.

### Fallo controlado y diagnóstico de captura

Primero se intentó capturar resultados con este script; falló en la primera
aserción, antes de modificar el test:

```python
from pathlib import Path
import subprocess
p = Path('api/test/health.test.ts')
original = p.read_text()
logs = Path('/tmp/k006-evidence')
def run(name):
    result = subprocess.run(['npm', '--prefix', 'api', 'test'], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (logs / (name + '.txt')).write_text(
        result.stdout + '\nEXIT_CODE=' + str(result.returncode) + '\n')
    print(name, result.stdout, 'EXIT_CODE=', result.returncode)
    return result.returncode
assert run('01-test-correcto') == 0
try:
    assert 'assert.equal(response.status, 200)' in original
    p.write_text(original.replace('assert.equal(response.status, 200)',
                                  'assert.equal(response.status, 503)'))
    failed = run('02-test-roto')
finally:
    p.write_text(original)
assert failed != 0
assert p.read_text() == original
assert run('03-test-restaurado') == 0
print('Restauración exacta verificada; secuencia 0 -> 1 -> 0')
```

Se diagnosticó además la redirección en `api/`:

```bash
npm test > /tmp/k006-evidence/01-test-correcto.txt 2>&1
result=$?
cat /tmp/k006-evidence/01-test-correcto.txt
exit "$result"
node --import tsx --test --test-reporter=tap test/health.test.ts > /tmp/k006-evidence/diagnostic.tap 2>&1
cat /tmp/k006-evidence/diagnostic.tap
```

La demostración exitosa se hizo después con tres invocaciones directas de
`npm test`, intercalando `apply_patch` para cambiar/restaurar la expectativa y
usando `try/finally` en el orquestador de herramientas. Sus salidas completas
están arriba; no se usó la variante sin aislamiento para esa demostración.

### Smoke local

```bash
# En api/:
PORT=33006 node dist/index.js
node dist/worker.js
# En web/:
API_PROXY_TARGET=http://127.0.0.1:33006 VITE_API_BASE_URL=/api npm run dev -- --host 127.0.0.1 --port 5176 --strictPort
# Desde la raíz:
curl --fail --silent --show-error http://127.0.0.1:33006/health
curl --fail --silent --show-error --output /tmp/k006-evidence/web.html --write-out 'Web HTTP %{http_code}\n' http://127.0.0.1:5176/
curl --fail --silent --show-error http://127.0.0.1:5176/api/health
ps -eo pid,args
```

API, Vite y curl se repitieron fuera del sandbox para comprobar la red real.
Se cerraron las tres sesiones de procesos con Ctrl-C. El cierre limpio por
SIGTERM del worker se comprobó aparte con `python3` en `api/`:

```python
import subprocess, time
p = subprocess.Popen(['node', 'dist/worker.js'], stdout=subprocess.PIPE,
                     stderr=subprocess.STDOUT, text=True)
try:
    assert 'Worker K006 iniciado' in p.stdout.readline()
    time.sleep(0.3)
    assert p.poll() is None
    p.terminate()
    output = p.communicate(timeout=5)[0]
    print(output)
    assert 'SIGTERM' in output
    assert p.returncode == 0
    print('Worker: activo antes de SIGTERM; salida 0 después de SIGTERM')
finally:
    if p.poll() is None:
        p.kill()
        p.wait()
```

### Revisión final

```bash
git diff --check
git status --short
git diff --stat
git diff -- api/src/index.ts api/package.json web/package.json web/vite.config.ts
git check-ignore .env api/.env web/.env api/node_modules api/dist web/node_modules web/dist
git ls-files --others --exclude-standard
```

Las validaciones de Compose y actionlint se repitieron después del último ajuste
de configuración. Los archivos nuevos siguen sin agregar al índice; por eso
`git diff --stat` solo muestra los cinco archivos ya versionados modificados.
