# ADR 0001: gestor de migraciones

Fecha: 2026-09-20. Tarjeta: K002.
Estado: decisión adoptada en esta rama y validada contra PostgreSQL 16.15.

## Contexto

Rescate tiene cinco integrantes, una API Express/TypeScript ESM con NodeNext y un
frontend React/Vite. Cada paquete tiene su propio lockfile; no hay paquete raíz,
ORM, migraciones, CI ni Compose. El backend solo expone `/health` y todavía no
declaraba `pg`: se incorpora como dependencia directa, sin agregar acceso al dominio.
K003 definirá el modelo; K006 definirá Docker. Buscamos un flujo npm reproducible,
con SQL revisable, historial y reversión local, sin modificar el build existente.

## Alternativas consideradas y evidencia

- **node-pg-migrate 9.0.0**, versión consultada en npm e instalada primero en `/tmp`.
  Se inspeccionaron su paquete, README, CLI, cargador y plantilla SQL. Se ejecutó
  `--help` y `create probe --migration-file-language sql` satisfactoriamente.
- **dbmate 2.36.0**, consultado en npm e instalado únicamente en `/tmp`. Se ejecutaron
  `--version`, `--help` y `--migrations-dir /tmp/rescate-k002-probe-dbmate new probe`.
  Se verificaron el binario y los marcadores SQL generados.
- **Flyway 13.7.0**, release verificada mediante la API de GitHub y documentación
  oficial de la distribución 13.7.0. Evaluación documental: no se descargó ni ejecutó
  su CLI; no hay Java ni Docker operativo en este entorno. La distribución por
  plataforma incluye JRE, por lo que no exige instalar Java por separado.

La comparación inicial se realizó sin servidor. Posteriormente se instaló PostgreSQL
16.15 en un directorio temporal y se validó el gestor elegido con una base exclusiva:
creación, registro, segunda ejecución sin cambios, rollback y reaplicación.
`npm run db:test` terminó con código 0. dbmate y Flyway no se probaron contra
PostgreSQL; la comparación no es un benchmark. La [guía](../migraciones.md) conserva
los resultados reales y los pasos de reproducción.

## Criterios de comparación

Priorizamos reproducibilidad con npm, PostgreSQL, pocas herramientas adicionales,
up/down explícito, facilidad para cinco estudiantes y continuidad hacia K003.
El soporte para varios motores y las funciones empresariales tienen menor peso.

| Criterio | node-pg-migrate 9.0.0 | dbmate 2.36.0 | Flyway 13.7.0 |
| --- | --- | --- | --- |
| PostgreSQL | Específico para PostgreSQL; README declara 13+ | Driver PostgreSQL y SQL nativo; no se verificó una versión mínima del servidor | Driver JDBC PostgreSQL incluido; documentación lista versiones verificadas 9.2 y 18, no una prueba nuestra |
| Node/TypeScript | Paquete ESM, API tipada; CLI admite TS/JS/SQL | Invocable desde npm; ejecuta binario, no migraciones TS | CLI independiente; SQL o Java, sin integración TS necesaria |
| Instalación local | npm y `pg`, mismo runtime de API | npm instala ejecutable por plataforma; no requiere instalar Go | Distribución adicional con JRE y JDBC, fuera del lockfile npm |
| Formato | SQL con `-- Up Migration` / `-- Down Migration`; también JS/TS | SQL con `-- migrate:up` / `-- migrate:down` | SQL versionado `V1__descripcion.sql`; también migraciones repetibles |
| Reversión | `down 1`, SQL explícito | `rollback`, SQL explícito | `undo` requiere Teams; Community puede usar una nueva migración compensatoria |
| Registro | `public.pgmigrations`: id, nombre, fecha | `schema_migrations`: versión | `flyway_schema_history`, incluye checksum |
| Repetición | `up` selecciona pendientes por historial | `migrate` selecciona pendientes | `migrate` omite versionadas aplicadas; repetibles tienen otra semántica |
| Estado | Consulta SQL del historial; CLI sin subcomando status | `status` integrado | `info` y `validate` |
| Docker/CI futuro | Node + npm ci + URL; incluir devDependencies para migrar | Binario o imagen dedicada; `--no-dump-schema` evita requerir pg_dump | Imagen/distribución dedicada y variables JDBC |
| Cinco estudiantes | Un solo ecosistema; nombres timestamp y revisión SQL | Flujo SQL sencillo, buen estado integrado; verificar soporte de cada plataforma | Más configuración y conceptos de edición/licencia que explicar |
| Complejidad operacional | Baja en este repositorio; sin ORM ni configuración compilada | Baja; desactivar dump si no se quiere schema.sql ni pg_dump adicional | Mayor para este stack, aunque ofrece validación de checksums útil |
| K003 | SQL permite tablas, restricciones, índices y relaciones sin cambiar `pg` | Igual capacidad con SQL PostgreSQL | Igual capacidad con SQL PostgreSQL; reversión gratuita mediante avance compensatorio |

## Comparación de node-pg-migrate

Reutiliza Node y `pg`; el requisito de su paquete es Node >=20.11, pero su
dependencia yargs 18 exige ^20.19, ^22.12 o >=23. Rescate establece mínimo 22.13
y recomienda 24, incluyendo soporte para `--env-file-if-exists`.
Se elige SQL para evitar loaders TS, ampliar `rootDir` o compilar migraciones.
El CLI intenta cargar dotenv opcionalmente, pero no lo instala: usamos la carga
nativa de Node explícita. Conservamos transacciones y advisory lock predeterminados.
El historial evita repetir archivos; no sustituye una validación de checksums.

## Comparación de dbmate

Es una alternativa competitiva: SQL, carga de `.env`, rollback y status integrados.
No precisa Go en las máquinas del equipo. Su paquete npm distribuye un binario;
el volcado de esquema predeterminado añade pg_dump al flujo PostgreSQL, aunque
`--no-dump-schema` lo evita. Para Rescate, su independencia de lenguaje no aporta
una ventaja clara frente al runtime Node ya necesario. No se descarta por falta de
compatibilidad con TypeScript: las migraciones SQL son independientes del backend.

## Comparación de Flyway

Ofrece historial con checksums, info y validate, adecuados para control de cambios.
Su CLI trae PostgreSQL JDBC y JRE en las distribuciones de plataforma. No reemplazaría
`pg` en la API, pero introduciría otro runtime y otra distribución que mantener.
Community permite migraciones SQL versionadas; el comando undo pertenece a Teams.
Para este equipo y esta prueba, el costo de configuración supera sus ventajas.

## Decisión y justificación

Elegimos **node-pg-migrate 9.0.0**, fijado en package.json y package-lock.json,
con `pg 8.23.0` directo y migraciones SQL. Su ajuste al ecosistema existente y la
reversión sin licencia adicional pesan más que el status de dbmate o los checksums
de Flyway. No existe evidencia del repositorio que justifique otro runtime.

## Consecuencias positivas

- Instalación con `npm ci`; comandos en API sin modificar frontend ni tsconfig.
- SQL explícito y portable entre las máquinas del equipo con PostgreSQL disponible.
- Prueba técnica aislada del dominio; historial y up/down proporcionados por el gestor.

## Consecuencias y costos

- Se requiere provisionar PostgreSQL aparte en cada entorno; el ciclo real de K002 ya pasó en 16.15.
- El gestor es devDependency: el paso de migración debe instalar también dependencias de desarrollo.
- No editar migraciones compartidas ya aplicadas: el historial no garantiza detectar cambios.
- `down` puede destruir datos. La prueba elimina solamente la tabla técnica y exige base nueva.
- Los timestamps reducen conflictos, pero requieren revisar orden al integrar ramas.
- La tabla técnica permanece al aplicar todo el historial. Acordar su retiro posterior
  mediante una nueva migración, sin borrar archivos ya compartidos.

## Integración con K003, K006 y CI

K003 agregará migraciones SQL nuevas, con revisión de restricciones y de su down;
esta rama solo crea `migration_tool_test(id integer PRIMARY KEY)`.
La prueba `db:test` es exclusiva de K002 y rechaza carpetas con más migraciones:
K003 deberá adaptar la prueba o moverla a un fixture antes de reutilizarla.
K006 podrá ejecutar `npm ci` y `npm run db:migrate` desde la imagen de API en un paso
dedicado. CI podrá inyectar DATABASE_URL y provisionar una base efímera antes de
ejecutar la prueba. Aquí no se agrega Compose, workflow ni migración al arrancar Express.

## Fuentes consultadas

- [node-pg-migrate v9.0.0: código, README y paquete](https://github.com/salsita/node-pg-migrate/tree/v9.0.0).
- [dbmate: documentación oficial](https://github.com/amacneil/dbmate), contrastada con el CLI npm 2.36.0.
- [Flyway 13.7.0: release](https://github.com/flyway/flyway/releases/tag/flyway-13.7.0).
- [Flyway CLI y distribución](https://documentation.red-gate.com/flyway/reference/usage/command-line).
- [Flyway PostgreSQL](https://documentation.red-gate.com/flyway/reference/database-driver-reference/postgresql-database).
- [Flyway versionadas](https://documentation.red-gate.com/flyway/flyway-concepts/migrations/versioned-migrations).
- [Flyway undo y edición](https://documentation.red-gate.com/flyway/reference/commands/undo).
