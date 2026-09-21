# K010 — Evidencia de ejecución

Ejecuciones reales de la tarjeta K010 sobre la rama `feature/lotes-k010`.
Las decisiones y el contrato están en
[k010-publicacion-lotes.md](k010-publicacion-lotes.md).

## Reconciliación con development — ejecución nueva, 2026-09-21

Base remota comprobada: `origin/development` `e4e04609c800e9b709f937df882f4d581d22db42`.
Se incorporó con `git merge --no-commit --no-ff origin/development`; único conflicto
textual en `docs/README.md`, resuelto conservando la organización de development y
agregando K010/evidencia. No se creó commit ni se hizo push. Árbol de trabajo revisable.

Entorno de esta ejecución: Linux, Node 24.14.0, npm 11.19.0 y PostgreSQL 16.9
(Debian) del servicio Compose K006. Se inició únicamente `db`; no se ejecutó CI remoto.

| Comando/comprobación | Resultado nuevo |
| --- | --- |
| `npm --prefix api ci` (lockfile final) | Exit 0; 170 paquetes añadidos, 0 vulnerabilidades reportadas |
| `npm --prefix web ci` | Exit 0; 166 paquetes añadidos, 0 vulnerabilidades reportadas |
| `npm --prefix api run api:types` y `api:types:check` | DTO derivados del YAML; sincronización correcta |
| `npm --prefix api run api:contract:check` | Redocly válido; YAML sin cambios frente a development |
| `npm --prefix api run typecheck` y `build` | Exit 0 |
| `npm --prefix api test` | **25 tests, 25 pasan** |
| `npm --prefix api run db:test:lots:compose` | **29 comprobaciones PostgreSQL reales, PASS** |
| `npm --prefix api run db:test:compose` | **130 comprobaciones, PASS** |
| Web: `typecheck`, `lint`, `build` | Exit 0; web no dispone de script de tests |
| Enlaces locales Markdown | 180 destinos existentes |
| Mermaid | 3 diagramas parseados con Mermaid en /tmp; sin render visual |
| `git diff --check`, diff staged y marcadores | Sin errores ni conflictos sin resolver |
| OpenAPI y migraciones preexistentes | Diff vacío contra development/HEAD respectivamente |

Bases dedicadas del run final (sin alterar base de desarrollo):

- `rescate_k010_test_1790015184841_23fedfbf`
- `rescate_k003_test_1790015186647_00c1ac0d`

Logs completos locales: `/tmp/rescate-k010-reconciled-db.log` y
`/tmp/rescate-k010-reconciled-migrations.log`. Se conservan bases ficticias para
inspección según los wrappers existentes.

### Cobertura nueva y corregida

Los tests HTTP ejercitan creación con ID público, permiso/no permiso, consulta
propia/ajena, PATCH parcial preservando omitidos, null explícito, validación de
ventana final, propiedades desconocidas, versión obsoleta, publicación/repetición,
inmutabilidad y ausencia de rutas antiguas. Cubren JSON ilegible, 16 KiB, media type,
422, 401/403/404/409 y fallos 500/503 sin filtrar diagnósticos.
Cada respuesta del harness se valida con Ajv JSON Schema 2020-12 leyendo el YAML
real: schema por operación/status, propiedades cerradas, condicional draft/published
y `Cache-Control: no-store`. **Esto sí es validación de respuestas HTTP en tests**;
Redocly por separado solo comprueba estructura y ejemplos. No hay validador de
schemas en runtime de producción ni pruebas de seguridad K008.

PostgreSQL prueba dos publicaciones y edición contra publicación con exactamente
un ganador y `version_conflict` en el perdedor (ya no admite `code === undefined`).
Comprueba rollback tras una escritura seguida de error SQL y tras marcar publicado
seguido de fallo, preservando datos, versión y fecha. Incluye IDs públicos distintos
de PK, migración/reaplicación sobre establecimientos existentes y conservación de
historia K002/K003 al retroceder las migraciones K010. No se modificó ninguna de
las tres migraciones preexistentes; la cuarta es aditiva.

### Alcance pendiente

K008 reemplazará `Authenticate → Actor` y añadirá sesión real, cookies y protección
Origin/CSRF para comandos. No está implementado en K010; actor temporal requiere
habilitación explícita y falla con NODE_ENV=production. K012 deberá verificar el
recorrido autenticado completo con navegador/HTTPS y seguridad. No se afirma que
CI remoto haya pasado ni que K010 complete E2.

## Registro original de Felipe — histórico, previo a OpenAPI

El registro siguiente se conserva íntegro: sus rutas, códigos, número de tests y
pendientes describen la ejecución original, no el contrato reconciliado actual.

## Entorno

| Dato | Valor |
| --- | --- |
| Fecha | 21/09/2026 |
| Sistema | macOS 24.6.0, Apple Silicon |
| Node | 24.8.0 |
| PostgreSQL | 14.15 de Homebrew, clúster temporal fuera del proyecto |

**Limitación declarada:** el motor de Docker del equipo dejó de responder
durante esta sesión, así que la prueba de integración se ejecutó contra un
PostgreSQL 14 local en vez del servicio de Compose. K010 no usa PostGIS ni
funciones exclusivas de PostgreSQL 16; `gen_random_uuid()` existe desde
PostgreSQL 13. La ejecución sobre el servicio de K006 queda pendiente de
confirmar en CI, donde el mismo script corre con `db:test:lots:compose`.

## Pruebas automatizadas

```bash
cd api
npm run typecheck        # sin errores
npm test                 # 22 pruebas, 0 fallos
npm run build            # compila
```

`npm test` cubre las reglas puras (`test/lots-domain.test.ts`, 11 pruebas) y el
recorrido HTTP → Application → Domain con repositorio en memoria
(`test/lots-http.test.ts`, 11 pruebas): contrato, errores, autorización de un
operador ajeno, versión optimista, inmutabilidad tras publicar y actor de
desarrollo deshabilitado por omisión.

## Integración con PostgreSQL

```bash
DATABASE_URL=postgresql://…/rescate_k010_test_… npm run db:test:lots
```

Resultado: `PASS K010: 26 comprobaciones sobre PostgreSQL real`, repetido dos
veces sobre bases nuevas. Cubre, entre otras:

- borrador persistido con identificador público opaco y versión 1;
- operador ajeno rechazado al crear, consultar, editar y publicar, sin modificar
  la fila;
- declaraciones inválidas que no insertan ninguna fila;
- edición con versión superada rechazada sin sobrescribir la vigente;
- **publicación concurrente:** dos publicaciones simultáneas del mismo lote
  producen una sola transición, versión 3 y un único `published_at`;
- lote publicado inmutable y no republicable;
- publicación rechazada con la ventana de retiro ya terminada;
- rollback de K010 que conserva historial y datos de K002 y K003, y reaplicación
  que asigna identificador a las filas existentes.

## Historial de migraciones

```bash
DATABASE_URL=postgresql://…/rescate_k003_test_… npm run db:test
```

Resultado: `PASS K003: 129 comprobaciones`. El script de K003 se amplió para
incluir la migración de K010 y ahora revierte primero K010 y después K003:

```text
OK 2:  desde cero: K002, K003 y K010 registradas una vez
OK 65: rollback de K010: columnas propias retiradas; las cinco tablas de K003 permanecen
OK 66: rollback solo K003: cinco tablas ausentes; K002 conserva historial, OID y dato
```

## Recorrido HTTP con la API real

API iniciada con `node dist/index.js` contra la base migrada, con
`RESCATE_DEV_ACTOR=enabled` y datos ficticios.

| Solicitud | Resultado observado |
| --- | --- |
| `GET /health` | `200 {"status":"ok"}` |
| `POST /lots` sin cabecera de actor | `401 not_authenticated` |
| `POST /lots` con declaración válida | `201`, estado `draft`, versión 1, `id` uuid |
| `POST /lots/:id/publication` | `200`, estado `published`, versión 2, `publishedAt` fijado |
| `PATCH /lots/:id` sobre el lote publicado | `409 lot_state_conflict`, `published_lot_is_immutable` |
| `GET /lots?establishmentId=1&status=published` | `200` con un lote |
| `GET /lots?establishmentId=999` | `404` |
| `POST /lots` con `quantity: 0` | `422 invalid_lot`, `quantity_out_of_range` |
| Cuerpo JSON mal formado | `400 invalid_request` |

El proceso registró la advertencia del actor de desarrollo al arrancar, como
está previsto.

## Pendiente de comprobar

- Ejecución de `db:test:lots:compose` sobre el servicio de K006 en CI.
- Recorrido con sesión real, al integrarse K008.
