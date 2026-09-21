# K010 — Evidencia de ejecución

Ejecuciones reales de la tarjeta K010 sobre la rama `feature/lotes-k010`.
Las decisiones y el contrato están en
[k010-publicacion-lotes.md](k010-publicacion-lotes.md).

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
