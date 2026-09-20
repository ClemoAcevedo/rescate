# K003 — Evidencia de ejecución y propuesta de PR

Fecha: 2026-09-20. Rama `feat/k003-initial-data-model`.
Base `00597b800491a77fe85150414d5321d45dbabd63`, idéntica a `development` y
`origin/development` locales al iniciar. Árbol inicialmente limpio. No se hizo
commit, push, merge ni publicación de PR. No se encontraron AGENTS.md aplicables.

## Resultado

**Implementación y aceptación local K003 aprobadas**: 128 comprobaciones sobre
PostgreSQL real, incluyendo dos pasadas del modelo (antes y después de rollback).
No se declara RF04 transaccional completo ni S01 integrada: quedan revisión de otro
integrante, PR e integración. El [modelo](modelo-inicial.md) documenta atributos,
PK/FK, fuentes A/B/C, estados, restricciones, ambigüedades y trabajo pospuesto.

Entorno: Node 24.14.0, npm 11.19.0, node-pg-migrate 9.0.0 y pg 8.23.0.
Servidor real **PostgreSQL 16.9 (Debian 16.9-1.pgdg110+1)** del servicio `db`
K006, imagen `postgis/postgis:16-3.5`. No es el servidor temporal usado por K002.
No se levantó otro PostgreSQL, Compose, volumen ni contenedor de pruebas.

## Reproducción

Desde la raíz, con el servicio db de K006 ya iniciado:

```bash
npm --prefix api ci
npm --prefix api run db:test:compose
```

El wrapper obtiene en memoria usuario/contraseña/puerto del servicio existente,
crea una base nueva con nombre aleatorio `rescate_k003_test_*` desde `template0`
y pasa DATABASE_URL a `npm run db:test`, sin imprimir credenciales ni escribir
.env. El comando se añadió al job Compose de CI ya existente. La instalación
no cambia versiones, lockfiles, gestor ni scripts db:migrate/create/rollback.

También se puede provisionar manualmente una base vacía dedicada con ese prefijo,
configurar DATABASE_URL y ejecutar `npm run db:test` desde api/. La prueba exige
carpeta con las dos migraciones revisadas, nombre dedicado y cero relaciones de
usuario. No borra bases ni intenta limpiar una base ajena. Al fallar conserva el
estado para inspección; para repetir desde cero hay que usar otra base nueva.

## Secuencia real desde cero

Salida saneada de `npm run db:test:compose` (exit **0**). Se omiten solo los bloques
SQL que el CLI imprime y que ya están versionados; se conservan todos los mensajes
de comprobación, sin simular resultados:

```text
Base dedicada creada en db de K006: rescate_k003_test_1789932991441_e36208fc (template0)
OK 1: PostgreSQL 16.9 (Debian 16.9-1.pgdg110+1); base rescate_k003_test_1789932991441_e36208fc: vacía (0 relaciones de usuario)
OK 2: desde cero: K002 + K003 registradas una vez
OK 3: cinco tablas, cinco PK bigint identity y cinco FK reales verificadas en catálogos
OK 4: usuarios y establecimientos válidos; membresías N:M aceptadas
OK 5: lote borrador/publicado y compromiso válidos; JOIN usuario → compromiso → lote; 3 packs aceptados
OK 6: lots.quantity=0: PostgreSQL rechaza con 23514 (lots_quantity_check)
OK 7: lots.quantity=-1: PostgreSQL rechaza con 23514 (lots_quantity_check)
OK 8: lots.quantity=NULL: PostgreSQL rechaza con 23502
OK 9: lots.quantity=1.5 (parámetro): PostgreSQL rechaza con 22P02
OK 10: lots.quantity desborda integer: PostgreSQL rechaza con 22003
OK 11: commitments.quantity=0: PostgreSQL rechaza con 23514 (commitments_quantity_check)
OK 12: commitments.quantity=-1: PostgreSQL rechaza con 23514 (commitments_quantity_check)
OK 13: commitments.quantity=NULL: PostgreSQL rechaza con 23502
OK 14: commitments.quantity=1.5 (parámetro): PostgreSQL rechaza con 22P02
OK 15: commitments.quantity desborda integer: PostgreSQL rechaza con 22003
OK 16: límites válidos 1 y 101 aceptados; sin imponer supuesto de 100 ni máximo de 2
OK 17: memberships.user_id inexistente: PostgreSQL rechaza con 23503 (memberships_user_id_fkey)
OK 18: memberships.user_id=NULL: PostgreSQL rechaza con 23502
OK 19: memberships.establishment_id inexistente: PostgreSQL rechaza con 23503 (memberships_establishment_id_fkey)
OK 20: memberships.establishment_id=NULL: PostgreSQL rechaza con 23502
OK 21: lots.establishment_id inexistente: PostgreSQL rechaza con 23503 (lots_establishment_id_fkey)
OK 22: lots.establishment_id=NULL: PostgreSQL rechaza con 23502
OK 23: commitments.user_id inexistente: PostgreSQL rechaza con 23503 (commitments_user_id_fkey)
OK 24: commitments.user_id=NULL: PostgreSQL rechaza con 23502
OK 25: commitments.lot_id inexistente: PostgreSQL rechaza con 23503 (commitments_lot_id_fkey)
OK 26: commitments.lot_id=NULL: PostgreSQL rechaza con 23502
OK 27: lots.status inválido: PostgreSQL rechaza con 23514 (lots_status_check,lots_publication_check)
OK 28: lots.status=NULL: PostgreSQL rechaza con 23502
OK 29: commitments.status inválido: PostgreSQL rechaza con 23514 (commitments_status_check)
OK 30: commitments.status=NULL: PostgreSQL rechaza con 23502
OK 31: correo duplicado: PostgreSQL rechaza con 23505 (users_email_key)
OK 32: membresía duplicada: PostgreSQL rechaza con 23505 (memberships_user_establishment_key)
OK 33: compromiso activo duplicado: PostgreSQL rechaza con 23505 (commitments_active_user_lot_key)
OK 34: unicidad activa no impide otro usuario en el mismo lote
OK 35: PK duplicada users: PostgreSQL rechaza con 23505 (users_pkey)
OK 36: PK duplicada establishments: PostgreSQL rechaza con 23505 (establishments_pkey)
OK 37: PK duplicada memberships: PostgreSQL rechaza con 23505 (memberships_pkey)
OK 38: PK duplicada lots: PostgreSQL rechaza con 23505 (lots_pkey)
OK 39: PK duplicada commitments: PostgreSQL rechaza con 23505 (commitments_pkey)
OK 40: borrado de users referenciado: PostgreSQL rechaza con 23503
OK 41: borrado de establishments referenciado: PostgreSQL rechaza con 23503
OK 42: borrado de lots referenciado: PostgreSQL rechaza con 23503
OK 43: ventana vacía: PostgreSQL rechaza con 23514 (lots_pickup_window_check)
OK 44: ventana invertida: PostgreSQL rechaza con 23514 (lots_pickup_window_check)
OK 45: publicado sin fecha: PostgreSQL rechaza con 23514 (lots_publication_check)
OK 46: borrador con fecha publicada: PostgreSQL rechaza con 23514 (lots_publication_check)
OK 47: establishments.latitude=91: PostgreSQL rechaza con 23514 (establishments_latitude_check)
OK 48: establishments.longitude=-181: PostgreSQL rechaza con 23514 (establishments_longitude_check)
OK 49: establishments.latitude=NaN: PostgreSQL rechaza con 23514 (establishments_latitude_check)
OK 50: establishments.longitude=Infinity: PostgreSQL rechaza con 23514 (establishments_longitude_check)
OK 51: lots.latitude=91: PostgreSQL rechaza con 23514 (lots_latitude_check)
OK 52: lots.longitude=-181: PostgreSQL rechaza con 23514 (lots_longitude_check)
OK 53: lots.latitude=NaN: PostgreSQL rechaza con 23514 (lots_latitude_check)
OK 54: lots.longitude=Infinity: PostgreSQL rechaza con 23514 (lots_longitude_check)
OK 55: users.email vacío: PostgreSQL rechaza con 23514 (users_email_check)
OK 56: establishments.name vacío: PostgreSQL rechaza con 23514 (establishments_name_check)
OK 57: establishments.address vacío: PostgreSQL rechaza con 23514 (establishments_address_check)
OK 58: establishments.time_zone vacío: PostgreSQL rechaza con 23514 (establishments_time_zone_check)
OK 59: lots.description vacío: PostgreSQL rechaza con 23514 (lots_description_check)
OK 60: lots.category vacío: PostgreSQL rechaza con 23514 (lots_category_check)
OK 61: lots.address vacío: PostgreSQL rechaza con 23514 (lots_address_check)
OK 62: lots.time_zone vacío: PostgreSQL rechaza con 23514 (lots_time_zone_check)
OK 63: descripción excede 2000 caracteres: PostgreSQL rechaza con 23514 (lots_description_check)
No migrations to run!
OK 64: segunda ejecución: 0 pendientes; historial, OID de tablas y datos intactos
OK 65: rollback solo K003: cinco tablas ausentes; K002 conserva historial, OID y dato
OK 66: upgrade desde K002/reaplicación: solo K003, sin alterar K002
OK 67: cinco tablas, cinco PK bigint identity y cinco FK reales verificadas en catálogos
OK 68: usuarios y establecimientos válidos; membresías N:M aceptadas
OK 69: lote borrador/publicado y compromiso válidos; JOIN usuario → compromiso → lote; 3 packs aceptados
OK 70: lots.quantity=0: PostgreSQL rechaza con 23514 (lots_quantity_check)
OK 71: lots.quantity=-1: PostgreSQL rechaza con 23514 (lots_quantity_check)
OK 72: lots.quantity=NULL: PostgreSQL rechaza con 23502
OK 73: lots.quantity=1.5 (parámetro): PostgreSQL rechaza con 22P02
OK 74: lots.quantity desborda integer: PostgreSQL rechaza con 22003
OK 75: commitments.quantity=0: PostgreSQL rechaza con 23514 (commitments_quantity_check)
OK 76: commitments.quantity=-1: PostgreSQL rechaza con 23514 (commitments_quantity_check)
OK 77: commitments.quantity=NULL: PostgreSQL rechaza con 23502
OK 78: commitments.quantity=1.5 (parámetro): PostgreSQL rechaza con 22P02
OK 79: commitments.quantity desborda integer: PostgreSQL rechaza con 22003
OK 80: límites válidos 1 y 101 aceptados; sin imponer supuesto de 100 ni máximo de 2
OK 81: memberships.user_id inexistente: PostgreSQL rechaza con 23503 (memberships_user_id_fkey)
OK 82: memberships.user_id=NULL: PostgreSQL rechaza con 23502
OK 83: memberships.establishment_id inexistente: PostgreSQL rechaza con 23503 (memberships_establishment_id_fkey)
OK 84: memberships.establishment_id=NULL: PostgreSQL rechaza con 23502
OK 85: lots.establishment_id inexistente: PostgreSQL rechaza con 23503 (lots_establishment_id_fkey)
OK 86: lots.establishment_id=NULL: PostgreSQL rechaza con 23502
OK 87: commitments.user_id inexistente: PostgreSQL rechaza con 23503 (commitments_user_id_fkey)
OK 88: commitments.user_id=NULL: PostgreSQL rechaza con 23502
OK 89: commitments.lot_id inexistente: PostgreSQL rechaza con 23503 (commitments_lot_id_fkey)
OK 90: commitments.lot_id=NULL: PostgreSQL rechaza con 23502
OK 91: lots.status inválido: PostgreSQL rechaza con 23514 (lots_status_check,lots_publication_check)
OK 92: lots.status=NULL: PostgreSQL rechaza con 23502
OK 93: commitments.status inválido: PostgreSQL rechaza con 23514 (commitments_status_check)
OK 94: commitments.status=NULL: PostgreSQL rechaza con 23502
OK 95: correo duplicado: PostgreSQL rechaza con 23505 (users_email_key)
OK 96: membresía duplicada: PostgreSQL rechaza con 23505 (memberships_user_establishment_key)
OK 97: compromiso activo duplicado: PostgreSQL rechaza con 23505 (commitments_active_user_lot_key)
OK 98: unicidad activa no impide otro usuario en el mismo lote
OK 99: PK duplicada users: PostgreSQL rechaza con 23505 (users_pkey)
OK 100: PK duplicada establishments: PostgreSQL rechaza con 23505 (establishments_pkey)
OK 101: PK duplicada memberships: PostgreSQL rechaza con 23505 (memberships_pkey)
OK 102: PK duplicada lots: PostgreSQL rechaza con 23505 (lots_pkey)
OK 103: PK duplicada commitments: PostgreSQL rechaza con 23505 (commitments_pkey)
OK 104: borrado de users referenciado: PostgreSQL rechaza con 23503
OK 105: borrado de establishments referenciado: PostgreSQL rechaza con 23503
OK 106: borrado de lots referenciado: PostgreSQL rechaza con 23503
OK 107: ventana vacía: PostgreSQL rechaza con 23514 (lots_pickup_window_check)
OK 108: ventana invertida: PostgreSQL rechaza con 23514 (lots_pickup_window_check)
OK 109: publicado sin fecha: PostgreSQL rechaza con 23514 (lots_publication_check)
OK 110: borrador con fecha publicada: PostgreSQL rechaza con 23514 (lots_publication_check)
OK 111: establishments.latitude=91: PostgreSQL rechaza con 23514 (establishments_latitude_check)
OK 112: establishments.longitude=-181: PostgreSQL rechaza con 23514 (establishments_longitude_check)
OK 113: establishments.latitude=NaN: PostgreSQL rechaza con 23514 (establishments_latitude_check)
OK 114: establishments.longitude=Infinity: PostgreSQL rechaza con 23514 (establishments_longitude_check)
OK 115: lots.latitude=91: PostgreSQL rechaza con 23514 (lots_latitude_check)
OK 116: lots.longitude=-181: PostgreSQL rechaza con 23514 (lots_longitude_check)
OK 117: lots.latitude=NaN: PostgreSQL rechaza con 23514 (lots_latitude_check)
OK 118: lots.longitude=Infinity: PostgreSQL rechaza con 23514 (lots_longitude_check)
OK 119: users.email vacío: PostgreSQL rechaza con 23514 (users_email_check)
OK 120: establishments.name vacío: PostgreSQL rechaza con 23514 (establishments_name_check)
OK 121: establishments.address vacío: PostgreSQL rechaza con 23514 (establishments_address_check)
OK 122: establishments.time_zone vacío: PostgreSQL rechaza con 23514 (establishments_time_zone_check)
OK 123: lots.description vacío: PostgreSQL rechaza con 23514 (lots_description_check)
OK 124: lots.category vacío: PostgreSQL rechaza con 23514 (lots_category_check)
OK 125: lots.address vacío: PostgreSQL rechaza con 23514 (lots_address_check)
OK 126: lots.time_zone vacío: PostgreSQL rechaza con 23514 (lots_time_zone_check)
OK 127: descripción excede 2000 caracteres: PostgreSQL rechaza con 23514 (lots_description_check)
No migrations to run!
OK 128: reaplicación validada con toda la suite; segunda ejecución final: 0 pendientes
PASS K003: 128 comprobaciones; datos ficticios conservados para inspección
Base de prueba conservada: rescate_k003_test_1789932991441_e36208fc. No se alteró la base de desarrollo.
```

La segunda ejecución compara id/nombre/fecha del historial, OID de todas las tablas
y filas de compromisos. No basta con contar tablas. SQL sin IF NOT EXISTS, de modo
que una reaplicación indebida fallaría. El rollback ejecuta down 1 exclusivamente
cuando el historial es exactamente K002+K003; verifica que solo quedan la tabla
K002 y pgmigrations, con sus OID, registro histórico y dato técnico `(1)` intactos.
Luego aplica desde esa versión previa y repite toda la suite de integridad.

## Inspección SQL independiente posterior

Consulta con `docker compose exec -T db ... psql` sobre la base de prueba exitosa:

```text
base: rescate_k003_test_1789932991441_e36208fc
PostgreSQL 16.9 (Debian 16.9-1.pgdg110+1)

pgmigrations:
id  name                                     run_on
1   1789915246470_migration-tool-test          2026-09-20 19:36:31.86728
3   1789932753813_initial-rescate-model        2026-09-20 19:36:32.314137

tablas public:
commitments, establishments, lots, memberships,
migration_tool_test, pgmigrations, users

filas:
users=2; establishments=2; memberships=3; lots=1; commitments=2
```

Dos migraciones registradas; el id 3 corresponde a reaplicar K003 después de down,
no a una tercera migración ni a un duplicado. Los cinco objetos de dominio se
suman a la tabla técnica conservada de K002 y al historial del gestor.

## Checks y comandos ejecutados

| Comando / comprobación | Resultado real |
| --- | --- |
| `npm --prefix api ci` | Exit 0; 147 paquetes, 0 vulnerabilidades informadas; lockfile intacto |
| `npm --prefix api ls node-pg-migrate pg --depth=0` | 9.0.0 y 8.23.0 instalados |
| `npm run db:create -- initial-rescate-model` en api/ | Generó `1789932753813_initial-rescate-model.sql` |
| `node --check api/scripts/test-migrations.mjs` | Exit 0 |
| `node --check api/scripts/test-migrations-compose.mjs` | Exit 0 |
| `npm run db:test:compose` en api/ | Exit 0; 128 comprobaciones; incluye up/up/down 1/up/up del CLI K002 |
| `node /tmp/rescate-k003-guard.mjs` | Exit 0 del verificador: db:test devolvió 1 esperado ante base no vacía; historial y compromisos intactos |
| `npm run typecheck` en api/ | Exit 0 |
| `npm test` en api/, fuera del sandbox | Exit 0, 1 test HTTP aprobado |
| `npm run build` en api/ | Exit 0 |
| `node --test test/photos.test.mjs` en api/ | Exit 0, 3 tests locales K005 aprobados; sin acceso remoto B2 |
| `npm run typecheck` en web/ | Exit 0 |
| `npm run lint` en web/ | Exit 0 |
| `npm run build` en web/ | Exit 0, 34 módulos; Vite 8.3.0 |
| `/tmp/actionlint .github/workflows/ci.yml` | Exit 0, sin hallazgos |
| `docker compose config --quiet` | Exit 0 |
| `docker compose ps` | db/api/web healthy, worker Up; servicios existentes conservados |
| Consulta SQL posterior vía `docker compose exec -T db` | Exit 0, historial/esquema/filas mostrados arriba |
| `git diff --check` | Exit 0 |
| `git diff --exit-code -- api/migrations/1789915246470_migration-tool-test.sql api/package-lock.json compose.yaml` | Exit 0: historial, versiones e infraestructura intactos |

La suite prueba cada FK con identificador inexistente y NULL, cada PK duplicada,
los tres UNIQUE, ambos estados, ambas cantidades con cero/negativo/NULL/fracción/
desborde y límites válidos. También verifica rangos geográficos (incluidos NaN e
infinito), textos vacíos, descripción >2000, ventana invertida/vacía, publicación
incoherente y rechazo de borrado de padres referenciados. Todo SQL usa datos
completamente ficticios y correos del dominio reservado example.invalid.

Inspección adicional: `pwd`, `git status --short`, `git branch --show-current`,
`git log -6 --oneline`, `git rev-parse HEAD development origin/development`,
`rg --files`, búsqueda y lectura de AGENTS.md, lectura de docs/configuración/código,
extracción de ambos PDF con PyMuPDF en /tmp, `git diff --stat`, revisión de archivos
nuevos, secretos, marcadores de conflicto y exclusiones de artefactos.

## Incidencias reales durante el trabajo

- `pdftotext` no estaba instalado. pypdf disponible en /tmp omitía partes con
  ligaduras. Se instaló PyMuPDF temporalmente en /tmp (sin dependencia de proyecto)
  y se releyeron los PDF originales, recuperando las secciones de dominio.
- pip/npm ci fallaron inicialmente por DNS del sandbox; se repitieron con acceso
  autorizado y completaron. npm avisó del install script de esbuild, sin fallo
  posterior de TypeScript/build/tests.
- Docker devolvió permiso denegado dentro del sandbox. La prueba real se ejecutó
  fuera de él con autorización; no se sustituyó PostgreSQL por mocks.
- Primera ejecución real: base `rescate_k003_test_1789932975559_ea707936`.
  Migraciones y primeras 26 comprobaciones correctas. Falló una expectativa del
  test: estado inválido del lote viola tanto lots_status_check como
  lots_publication_check; PostgreSQL informó el segundo. Se corrigió la prueba
  para aceptar ambas restricciones y se usó otra base vacía. **No se modificó la
  migración ya aplicada.** La primera base también se conserva para inspección.
- El test HTTP dentro del sandbox devolvió `test failed`; fuera de él pasó sin
  cambiar el test. No se contabiliza el primer intento como aprobado.
- `docs/README.md` contenía marcadores de conflicto en la base integrada. Al agregar
  los enlaces K003 se retiraron, conservando los enlaces de K002 y K005.

## Archivos y límites de la validación

Nuevos:

- `api/migrations/1789932753813_initial-rescate-model.sql`
- `api/scripts/test-migrations-compose.mjs`
- `docs/modelo-inicial.md`
- `docs/k003-evidencia.md`

Modificados:

- `api/scripts/test-migrations.mjs`: adapta la aceptación K002 al historial actual.
- `api/package.json`: añade únicamente db:test:compose.
- `.github/workflows/ci.yml`: ejecuta la suite con el mismo servicio db del job Compose.
- `docs/migraciones.md`: explica la prueba actual y conserva la evidencia histórica.
- `docs/README.md`: enlaces al modelo/evidencia, con resolución de marcadores previos.

No se modificaron .env, lockfiles, SQL histórico, Compose, Dockerfiles, endpoints,
frontend ni fotos. Build/dependencias siguen ignorados; los extractores, PDF
extraídos, log completo y verificador auxiliar quedaron en /tmp, fuera del repo.
Las dos bases dedicadas se conservan en el volumen existente para inspección.
No se destruyó ninguna base ni volumen. Su eliminación eventual debe limitarse a
los nombres de pruebas anteriores, nunca a la base de desarrollo.

No se ejecutó GitHub Actions remoto ni se reconstruyeron las imágenes/servicios
K006: la infraestructura no cambió. Sí se ejecutaron la suite nueva contra db,
checks locales relevantes y validación estática de workflow/Compose. Los checks
remotos y revisión de otro integrante quedan para el PR. El SQL down pierde datos
K003 y no debe usarse como restauración de producción.

Revisión de dominio pendiente antes de S02/S03: normalización de correo,
categorías, guardado parcial de borradores, permisos y atributos públicos.
La instantánea de ubicación, identity, nombre de establecimiento, nullability,
CHECK text, defaults y ausencia de cascadas son decisiones técnicas documentadas.
E1 sí define bigint y timestamptz: no se presentan como decisiones nuevas.
El modelo no impide sobreasignación entre filas ni autoriza operaciones; esas
reglas, inventario Q/F/O/R/E/X, idempotencia y transiciones requieren sus tarjetas.

## Propuesta de título del PR

`feat(K003): crear modelo inicial y validar migraciones sobre PostgreSQL`

## Propuesta de descripción completa del PR

### Descripción

K003 necesitaba persistir usuarios, membresías, establecimientos, lotes y
compromisos con integridad verificable. Añade una migración SQL que crea esas
cinco entidades, PK bigint identity, cinco FK, cantidades integer positivas,
estados acotados y unicidad de correo, pertenencia y compromiso activo.
Un compromiso queda ligado realmente a su usuario y lote; PostgreSQL rechaza
cantidades inválidas y referencias inexistentes.

El modelo se deriva de E1/anexos, con distinción explícita de requisitos,
decisiones técnicas y aspectos abiertos. Usa node-pg-migrate 9.0.0 sin reescribir
la migración técnica K002 y reutiliza PostgreSQL del Compose K006. Amplía la prueba
db:test y la incorpora al job Compose existente. No implementa autenticación,
publicación, reserva transaccional, fotos, endpoints ni frontend.

### Cómo probar

Con db de K006 operativo, desde la raíz:

```bash
npm --prefix api ci
npm --prefix api run db:test:compose
npm --prefix api run typecheck
npm --prefix api test
npm --prefix api run build
```

La prueba crea una base vacía dedicada y la conserva. Ejecuta todas las
migraciones, comprueba integridad real, verifica segunda ejecución sin pendientes,
revierte solo K003, conserva K002 y vuelve a aplicar y probar. Nunca apuntar
manualmente la prueba a una base con datos útiles.

### Checklist

- [x] Probé los cambios localmente sobre PostgreSQL real.
- [x] Tests/build/types de API y checks/build de web aprobados.
- [x] Sin secretos, credenciales nuevas ni datos personales en el cambio.
- [x] Documentación actualizada con fuentes, decisiones y evidencia.
- [x] Criterios técnicos K003 comprobados.
- [ ] Revisión por otro integrante y checks remotos del PR.

### Evidencia

`docs/k003-evidencia.md`: 128 comprobaciones aprobadas en PostgreSQL 16.9 de K006;
rechazos SQLSTATE 23514/23502/22P02/22003/23503/23505, segunda ejecución sin
pendientes, rollback/reaplicación y actualización desde K002. Un test HTTP y tres
tests locales de fotos aprobados. Typecheck/build API, typecheck/lint/build web,
actionlint, configuración Compose y git diff --check correctos.

### Riesgos y alcance

Down elimina datos K003; no es un procedimiento de restauración. La persistencia
no implementa todavía control transaccional de stock ni el ciclo completo de
estados. Antes de exponer endpoints hay que resolver los aspectos abiertos del
modelo y agregar identificadores públicos opacos. CI remoto pendiente de abrir PR.

### Tarjeta

ID: K003 — Preparar la base y el modelo inicial. RF01, RF02 y RF04.
