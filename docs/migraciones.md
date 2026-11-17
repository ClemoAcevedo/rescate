# Migraciones PostgreSQL

Gestor: node-pg-migrate 9.0.0 con SQL plano y pg 8.23.0, sin ORM
([ADR 0001](adr/0001-gestor-de-migraciones.md)). Las migraciones están en
[api/migrations](../api/migrations) y el esquema que dejan, en el
[modelo de datos](modelo-inicial.md). No se edita una migración ya aplicada: un
cambio de esquema es una migración nueva dentro de la tarjeta que lo necesita.

## Historial

| Migración | Qué agrega | Área |
| --- | --- | --- |
| `1789915246470_migration-tool-test` | Tabla técnica de la prueba del gestor. | [ADR 0001](adr/0001-gestor-de-migraciones.md) |
| `1789932753813_initial-rescate-model` | `users`, `establishments`, `memberships`, `lots` y `commitments`. | [modelo](modelo-inicial.md) |
| `1789999138556_lots-publication-fields` | `public_id`, `version` y `updated_at` del lote. | [lotes](lotes.md) |
| `1790000000000_establishment-public-ids` | `public_id` del establecimiento. | [lotes](lotes.md) |
| `1790000000001_identity-sessions` | Correo canónico, `users.public_id`, credenciales, sesiones y límite de login. Exige `users` vacía. | [identidad](k008-identidad.md) |
| `1790620000000_public-reservations` | `public_id` y clave idempotente de la reserva. | [ADR 0004](adr/0004-reserva-directa-idempotente.md) |
| `1790700000000_discovery-postgis` | Extensión PostGIS e índice GiST de los lotes publicados. | [lotes](lotes.md#búsqueda-y-reserva-directa) |
| `1790800000000_lot-photos` | `lot_photos`. | [fotos](fotos.md) |
| `1790900000000_lot-inventory` | Contadores O, R, E, X y F generado en `lots`. | [ADR 0006](adr/0006-inventario-del-lote.md) |
| `1791000000000_reservation-transitions` | Estados terminales de la reserva, código cifrado y `deliveries`. | [reservas](reservas.md) |
| `1791100000000_lot-status-enum` | Enum `lot_status` y `closed_at`. | [ADR 0008](adr/0008-estado-del-lote-y-cierre-logico.md) |
| `1791100000001_user-consents` | `user_consents`. | [ADR 0009](adr/0009-consentimiento-del-correo.md) |
| `1791200000000_waitlist` | `waitlist_entries`. | [cola de espera](cola-de-espera.md) |
| `1791300000000_lot-expiry-claims` | Reclamo de vencimientos en `lots` e índice de ofertas por vencer. | [vencimientos](vencimientos.md) |
| `1791400000000_notifications-outbox` | `outbox_events` y `notifications`. | [avisos](avisos.md) |
| `1791500000000_commitments-lot-index` | Índice de compromisos por lote. | [rendimiento](rendimiento.md#índices) |
| `1791600000000_pickup-code-attempts` | Fallos y suspensión de códigos de retiro por operador. | [ADR 0013](adr/0013-limite-de-codigos-de-retiro.md) |
| `1791700000000_worker-heartbeat` | `worker_heartbeat`. | [operación](operacion.md#salud) |
| `1791800000000_chat-messages` | `chat_messages` y eventos de mensajes por destinatario. | [chat](chat.md) |
| `1791900000000_lot-management` | Pausa del lote, `lot_operations` y posiciones de foto sin máximo fijo. | [lotes](lotes.md#disponibilidad-después-de-publicar) |
| `1792000000000_incidents` | `incidents`, `incident_versions` e `incident_recipients`. | [incidencias](incidencias.md) |
| `1792100000000_incident-delivery` | Cierre del lote por versión y enlace de cada destinatario con su evento. | [incidencias](incidencias.md) |

## Revertir

`db:rollback` revierte solo la última migración aplicada y puede borrar datos: usarlo
en una base de prueba, nunca sobre producción. Para volver a un release anterior en
producción se restaura una copia ([operación](operacion.md#volver-al-release-anterior)).
Algunos rollback se niegan en vez de perder información:

- El envío de incidencias y el chat exigen que no queden eventos ni avisos de sus tipos.
- Gestión del lote falla si hay lotes pausados o fotos fuera de las posiciones 1 a 3.
- El enum del lote falla si quedan lotes vencidos o retirados.
- Las transiciones de reserva fallan si quedan reservas canceladas, vencidas o retiradas.
- Identidad conserva las cuentas; reaplicarla con usuarios aborta.

Las demás eliminan sus tablas o columnas con los datos: consentimientos, cola,
avisos, intentos de código, latido, fotos, inventario e ID públicos. El rollback
espacial retira el índice y conserva la extensión PostGIS compartida.

## Prueba del historial

Con el servicio `db` de Compose levantado:

```bash
npm --prefix api ci
npm --prefix api run db:test:compose
```

Crea una base `rescate_k003_test_<instante>_<sufijo>` desde `template0` en el
PostgreSQL de Compose y ejecuta `db:test` sobre ella. No cambia `.env`, no borra
bases y conserva la base para inspección, incluso ante fallo. Con una base vacía ya
provisionada, cuyo nombre empiece por `rescate_k003_test_`, basta exportar
`DATABASE_URL` y ejecutar `npm --prefix api run db:test`.

La [prueba](../api/scripts/test-migrations.mjs) aplica todo el historial, comprueba
tablas, PK, FK, restricciones con datos válidos e inválidos, una segunda ejecución
sin pendientes, el rollback de cada migración hasta K003 y la reaplicación. Rechaza
bases con relaciones previas y migraciones que no conoce. CI la ejecuta en el job
Compose. Ni la API ni Compose migran al arrancar; en producción migra el pre-deploy
de la API ([despliegue](despliegue.md)).

## Preparación

Usa Node 24 (mínimo API: 22.13), npm y una base PostgreSQL accesible.
El gestor declara soporte PostgreSQL 13+; recomendamos preparar PostgreSQL 16
para repetir esta prueba. Compose y producción usan PostgreSQL 16.
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
DATABASE_URL=postgresql://rescate_example:example_password@localhost:5432/rescate_dev
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
`psql -h localhost -U rescate_example -d rescate_dev` con tus valores reales.
Compara los nombres del historial con los archivos de `migrations/`; antes del
primer up, la tabla del historial puede no existir.
