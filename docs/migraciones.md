# Migraciones PostgreSQL — K002/K003/K010

Gestor: node-pg-migrate 9.0.0; controlador: pg 8.23.0.
La [decisión y comparación](adr/0001-gestor-de-migraciones.md) explica las alternativas.
K002 creó `public.migration_tool_test`, que se conserva sin modificaciones.
K003 añade las cinco entidades del [modelo inicial](modelo-inicial.md).
K010 añade identidad pública/versión de lotes y una migración posterior de IDs
públicos de establecimientos; ver [K010](k010-publicacion-lotes.md).
La evidencia histórica de K002 más abajo conserva su contexto original.

## Prueba actual de K003

Con el servicio `db` del Compose K006 operativo y dependencias de API instaladas:

```bash
cd api
npm ci
npm run db:test:compose
```

Este comando crea una base `rescate_k003_test_<timestamp>_<sufijo>` desde
`template0` en el PostgreSQL existente, toma su configuración sin imprimirla y
ejecuta `db:test`. No cambia `.env`, no levanta otro servidor ni borra bases.
Conserva la base con datos ficticios para inspección, incluso ante fallo.
Requiere Docker Compose y acceso desde el host al puerto loopback de K006.

Para una base vacía dedicada ya provisionada, exporta `DATABASE_URL` en el entorno y ejecuta
`npm run db:test`. Su nombre debe empezar por `rescate_k003_test_`.
La suite comprueba tablas/PK/FK, datos válidos e inválidos, historial, segunda
ejecución, down de las dos migraciones K010 y de K003, y reaplicación desde K002.
Rechaza bases con relaciones existentes y carpetas con migraciones no revisadas.
No ejecutar primero `db:migrate` sobre esa base de prueba: debe empezar vacía.

El job Compose existente ejecuta la misma suite en CI. No hay migración automática
al arrancar la API. Para migrar una base normal siguen vigentes `db:migrate` y
`db:rollback`; este último revierte una migración: actualmente retira el ID
público de establecimientos. Retroceder hasta K003 elimina sus tablas y datos. No usarlo en una base con datos que deban conservarse.
Ver [resultados K003](k003-evidencia.md). La sección de aceptación K002 de abajo
describe la versión histórica del script, reemplazada por esta prueba integrada.

## Preparación

Usa Node 24 (mínimo API: 22.13), npm y una base PostgreSQL accesible.
El gestor declara soporte PostgreSQL 13+; recomendamos preparar PostgreSQL 16
para repetir esta prueba. **Ciclo completo validado históricamente contra PostgreSQL 16.15** (evidencia más abajo).
La base debe existir y el usuario debe poder crear tablas en `public`.
Para consultar manualmente el historial se necesita también el cliente `psql`.

Desde la raíz del clon:

```bash
cd api
npm ci
cp .env.example .env
```

Edita `api/.env` con la conexión de una base local de prueba que hayas creado:

```dotenv
DATABASE_URL=postgresql://rescate_example:example_password@localhost:5432/rescate_k002_test
```

Estos valores son ficticios: copiar el ejemplo no crea usuarios ni bases.
`db:migrate`, `db:create`, `db:rollback` y `db:test` cargan `api/.env` mediante
Node al ejecutarse desde `api/`; la variable del entorno tiene prioridad.
`db:test:compose` construye e inyecta esa URL desde Compose.
`.env` está ignorado por Git.
Codifica caracteres reservados de usuario/contraseña en la URL. Para un servidor
remoto, configura TLS según sus requisitos; no desactives la validación del certificado.
La API `/health` no depende de esta variable ni ejecuta migraciones al iniciar.

## Comandos (desde api/)

```bash
npm run db:migrate
npm run db:create -- nombre-descriptivo
npm run db:rollback
```

- `db:migrate`: aplica pendientes de `api/migrations/` y registra en `public.pgmigrations`.
- `db:create`: genera un archivo SQL con prefijo timestamp. Completa ambos bloques
  `-- Up Migration` y `-- Down Migration` antes de aplicarlo.
- `db:rollback`: revierte **una** migración, la última aplicada; puede eliminar datos.

Mantén los archivos SQL fuera de `src/`; no requieren compilación ni cambios en
NodeNext. No edites migraciones que otros ya aplicaron: agrega otra migración.
Los comandos se resuelven desde API; la raíz del repositorio no tiene package.json.

## Estado e historial

El CLI 9.0.0 no tiene comando `status`. En una sesión SQL conectada a la misma base:

```sql
SELECT to_regclass('public.migration_tool_test') AS tabla_prueba;
SELECT to_regclass('public.pgmigrations') AS historial;
-- Después de la primera aplicación:
SELECT id, name, run_on FROM public.pgmigrations ORDER BY id;
```

Puedes abrir `psql` con `psql "$DATABASE_URL"` si exportaste DATABASE_URL en tu
terminal. **psql no carga api/.env**: alternativamente usa su conexión interactiva
`psql -h localhost -U rescate_example -d rescate_k002_test` con tus valores reales.
Compara los nombres del historial con los archivos de `migrations/`; antes del
primer up, la tabla del historial puede no existir.

## Prueba reproducible de aceptación K002 (histórica)

Desde aquí se conserva el procedimiento y la evidencia originales de K002,
incluidas las rutas temporales. No son instrucciones para ejecutar el script actual:
K003 lo sustituyó. Para el código vigente usar [Prueba actual de K003](#prueba-actual-de-k003).

Prepara una **base nueva de uso exclusivo para K002**, sin tablas en `public`,
y configura DATABASE_URL para esa base. No ejecutes primero `db:migrate`.

```bash
cd api # si estás en la raíz; omitir si ya estás en api/
npm ci
npm run db:test
```

El script usa `pg` real y el CLI instalado, sin mocks ni dry-run. Comprueba:

1. Tabla técnica ausente y esquema `public` sin tablas.
2. `up` crea la tabla y exactamente un registro con el nombre esperado.
3. Inserta un dato técnico y conserva el OID de la tabla y el historial.
4. Segundo `up`: mismo registro (id/nombre/fecha), mismo OID y mismo dato.
   El SQL no usa `IF NOT EXISTS`: una reaplicación indebida fallaría.
5. `down 1`: desaparece la tabla y el registro del historial.
6. Nuevo `up`: tabla vacía y una migración registrada nuevamente.

Solo una salida con todos los mensajes `OK` y código 0 acredita la prueba.
Al finalizar quedan la tabla técnica vacía y su historial aplicado. Para repetir,
usa otra base nueva. El script rechaza migraciones adicionales para no revertir
dominio cuando llegue K003. Ante un fallo, conserva la base para inspección;
no borra bases ni intenta recuperarlas automáticamente.

También puedes ejecutar manualmente `db:migrate`, las consultas de historial,
`db:migrate` otra vez, `db:rollback` y `db:migrate`, comprobando los mismos estados.

## Evidencia de esta implementación (2026-09-20)

Entorno: Linux/WSL, Node 24.14.0, npm 11.19.0.

| Comprobación | Resultado real |
| --- | --- |
| Instalación de versiones fijadas | pg 8.23.0 y node-pg-migrate 9.0.0 instalados; npm informó 0 vulnerabilidades |
| CLI y generación SQL | `db:create -- migration-tool-test` creó la migración incluida |
| Carga de entorno | Node cargó correctamente DATABASE_URL desde el ejemplo ficticio |
| Sin DATABASE_URL | migrate/rollback/test fallaron explícitamente por falta de configuración |
| Diagnóstico inicial | `pg_isready` sin respuesta en socket local y 127.0.0.1:5432; resuelto con una instancia aislada |
| Intentos iniciales con URL local ficticia | ECONNREFUSED 127.0.0.1:5432; no se contabilizaron como pruebas aprobadas |
| Servidor real | PostgreSQL 16.15, paquete Ubuntu 16.15-0ubuntu0.24.04.1, instancia aislada en /tmp |
| Prueba de aceptación | npm run db:test: código 0; aplicación, historial, repetición, rollback y reaplicación correctos |
| Scripts públicos | db:migrate (sin pendientes), db:rollback y db:migrate (reaplicación): los tres con código 0 |
| Build API | `npm run build` correcto |
| Sintaxis de prueba | `node --check scripts/test-migrations.mjs` correcto |
| Build/lint web | Ambos correctos tras restaurar node_modules con npm ci; el primer build falló porque faltaba react-router-dom instalado |
| Instalación reproducible API | npm ci y build posterior correctos; ninguna versión de dependencias preexistentes cambió |
| Revisión final | git diff --check correcto; .env, dist y node_modules ignorados; solo credenciales ficticias en archivos nuevos |

### Resultado real de aceptación

Se descargó el paquete oficial Ubuntu con `apt-get download
postgresql-16=16.15-0ubuntu0.24.04.1` y se extrajeron sus binarios mediante
`dpkg-deb -x` en `/tmp/rescate-k002-postgres`. No se instaló un servicio global ni
se alteraron bases preexistentes. El clúster exclusivo se inicializó en
`/tmp/rescate-k002-pgdata` y el socket en `/tmp/rescate-k002-pgsocket`, ambos con
permisos 0700. Usuario: `rescate_k002`; base: `rescate_k002_test`.

La instancia usó `listen_addresses=''` (sin TCP), socket privado en puerto lógico
55432, autenticación local trust y rechazo de conexiones host. No se usaron
contraseñas ni se creó un `.env` real: DATABASE_URL se inyectó en el entorno.
Esta autenticación es exclusiva de este clúster temporal privado.

La consulta inicial devolvió NULL para ambas tablas. La salida de `db:test` incluyó:

```text
OK: tabla ausente y public vacío
OK: tabla creada y una migración registrada
No migrations to run!
OK: segunda ejecución conserva historial, tabla y datos
OK: rollback elimina tabla y registro
OK: reaplicación; queda una tabla técnica vacía y un registro
```

Código de salida: **0**. Después se ejecutaron también los scripts públicos
`db:migrate`, `db:rollback` y `db:migrate`, todos con código 0. Consulta final:

```text
server_version: 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
base: rescate_k002_test
public: migration_tool_test, pgmigrations
filas en migration_tool_test: 0
pgmigrations:
  id: 3
  name: 1789915246470_migration-tool-test
  run_on: 2026-09-20 11:50:23.719014
```

El historial contiene **una sola fila**. El id 3 corresponde a las tres aplicaciones
(inicial, reaplicación de la prueba y reaplicación de los scripts públicos); el
rollback elimina el registro, pero no reinicia su secuencia.

La instancia se detuvo correctamente al terminar. Los binarios y los datos se
conservan en `/tmp` para inspección hasta su limpieza por el sistema; no forman
parte del repositorio. K002 tiene su prueba de aceptación aprobada. No se agregó
Docker Compose ni modelo de dominio.

### Repetir en este entorno temporal

Mientras existan los directorios anteriores, iniciar la misma instancia:

```bash
/tmp/rescate-k002-postgres/usr/lib/postgresql/16/bin/pg_ctl \
  -D /tmp/rescate-k002-pgdata -l /tmp/rescate-k002-pgdata/server.log \
  -o "-c listen_addresses='' -c unix_socket_directories='/tmp/rescate-k002-pgsocket' -p 55432" \
  -w start
```

La base original conserva el resultado, por lo que `db:test` rechazará ejecutarse
sobre ella. Para otra ejecución, crear una base nueva con un nombre no utilizado:

```bash
createdb -h /tmp/rescate-k002-pgsocket -p 55432 -U rescate_k002 rescate_k002_repeat
cd api
export DATABASE_URL='postgresql://rescate_k002@localhost:55432/rescate_k002_repeat?host=/tmp/rescate-k002-pgsocket'
npm run db:test
```

Detener únicamente este clúster al terminar:

```bash
/tmp/rescate-k002-postgres/usr/lib/postgresql/16/bin/pg_ctl \
  -D /tmp/rescate-k002-pgdata -m fast -w stop
```

En otro equipo no se necesitan estas rutas temporales: basta con una base PostgreSQL
vacía y la configuración de DATABASE_URL descrita al inicio de esta guía.
