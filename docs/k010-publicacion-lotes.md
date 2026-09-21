# K010 — Borrador y publicación de lotes

Tarjeta K010 (RF02). Implementación original: Felipe Arnolds. Revisión e integración:
Clemente Acevedo. Reconciliada con `origin/development` `e4e0460` el 2026-09-21.
La autoridad HTTP es [OpenAPI S02](api/openapi.yaml), sin modificaciones en esta
reconciliación. [Su guía](api/README.md) define transporte y seguridad objetivo.

## Alcance y reglas

K010 implementa crear un borrador completo, consultar, editar parcialmente con
versión y publicar. Mantiene la decisión original de no persistir formularios
incompletos: contenido, categoría provisional libre, cantidad, dirección,
coordenadas, zona horaria y ventana son obligatorios. `conditions` puede omitirse
al crear (null); no hay catálogo de categorías ni máximo comercial de 100 packs.
El límite de cantidad es el integer positivo de PostgreSQL; descripción tiene
hasta 2000 caracteres. Se retiraron los límites extra de categoría/dirección/
condiciones que el contrato no establecía. El cuerpo JSON tiene límite de 16 KiB.

RF02 conserva cantidad, contenido, lugar y plazo después de publicar. Editar o
republicar responde 409. Publicar exige cierre posterior al inicio y al instante
servidor leído después de bloquear el lote; ventana inválida responde 422.
Cero fotos permite publicar. No implementa fotos, retiro, búsqueda, reservas,
FIFO, ofertas, chat, incidencias ni trabajo de worker.

## Rutas y representación HTTP

Rutas Express relativas a la base API (el proxy web elimina `/api`):

| Método | Ruta | Resultado |
| --- | --- | --- |
| POST | `/establishments/:establishmentId/lots` | 201, borrador versión 1 |
| GET | `/lots/:lotId` | 200, lote del operador autorizado |
| PATCH | `/lots/:lotId` | 200, versión incrementada |
| POST | `/lots/:lotId/publish` | 200, publicado y versión incrementada |

Se retiraron `POST /lots`, `GET /lots` y `/publication`; no son alias.
No hay listado adicional ni índice nuevo para anticiparlo. El índice de la
migración original K010 se conserva para no reescribir historia compartida.

PATCH recibe `version` y al menos un campo editable. Omisión conserva el valor;
`conditions: null` borra condiciones. Solo ese campo admite null. Application
combina el patch con la declaración leída bajo bloqueo y Domain valida el
resultado completo, incluida la ventana. Un PATCH aceptado incrementa versión
aunque el valor coincida. Publicar recibe únicamente `{ "version": N }`.
`expectedVersion` permanece como nombre interno, nunca como campo HTTP.
Se rechazan propiedades desconocidas, reasignación de establecimiento y campos
de servidor. Fechas deben ser RFC 3339 con zona explícita; responses usan UTC.

El mapper HTTP deriva su tipo del YAML y expone solo `LotResponse`; no filas SQL,
PK internas ni `updatedAt`. Todas las respuestas llevan `Cache-Control: no-store`.

| Status | `error.code` | Uso |
| --- | --- | --- |
| 400 | MALFORMED_REQUEST | JSON ilegible |
| 401 | UNAUTHENTICATED | Actor ausente |
| 403 | FORBIDDEN | Falta membership; sin datos del recurso |
| 404 | NOT_FOUND | Lote/establecimiento inexistente |
| 409 | CONFLICT | Versión obsoleta o estado incompatible |
| 413 | PAYLOAD_TOO_LARGE | Cuerpo mayor a 16 KiB |
| 415 | UNSUPPORTED_MEDIA_TYPE | Cuerpo no JSON |
| 422 | VALIDATION_ERROR | Tipos, campos, propiedades extra o reglas inválidas |
| 500 | INTERNAL_ERROR | Fallo inesperado, sin diagnóstico interno público |
| 503 | SERVICE_UNAVAILABLE | Fallos identificables de disponibilidad PostgreSQL/red |

Errores siguen `{error:{code,message,details?}}`; `details.issues` contiene
`path` JSON Pointer y mensaje seguro, sin valores sensibles ni violaciones propias
del contrato anterior. Límites generales/rate limiting y seguridad de identidad
se integran mediante K008; no se afirma que K010 implemente todo S02.

## IDs públicos y migraciones

`lots.public_id` sigue siendo UUID persistido de la migración original
`1789999138556_lots-publication-fields.sql`; también conserva versión y updated_at
internos. La nueva migración **aditiva** `1790000000000_establishment-public-ids.sql`
añade `establishments.public_id uuid NOT NULL DEFAULT gen_random_uuid()` con UNIQUE.
Rellena filas existentes. No modifica K002, K003 ni la primera migración K010.

Application pide resolver el ID público del establecimiento a `{id, publicId}`,
exige membership sobre la PK interna y solo entonces inserta el lote. Los lotes
leídos conservan el establecimiento interno para autorizar y el público para HTTP.
Un texto bigint no identifica un establecimiento HTTP; responde 404. Los UUID
no conceden autoridad. No se añaden identificadores públicos de usuario anticipando K008.

## Responsabilidades y atomicidad

```text
HTTP → Application → Domain / ports → Infrastructure
             ↑ Composition ensambla dependencias concretas
```

HTTP parsea, obtiene actor y traduce errores. Application autoriza y define
`withLotTransaction`; Infrastructure abre BEGIN, hace SELECT FOR UPDATE, consulta
membership y escribe con el mismo cliente, confirma y lo libera. Domain mantiene
reglas puras. La versión se compara después de adquirir bloqueo: dos comandos
con N no pueden confirmar ambos. El perdedor obtiene conflicto; no se acepta un
error indefinido como evidencia de concurrencia. Un fallo posterior a escribir
revierte contenido, versión y publicación. No hay llamadas externas bajo bloqueo.

## Sesión real y conexión K008

`Authenticate → Actor` obtiene `Actor.userId` (PK interna) desde la sesión K008
vigente. HTTP extrae la cookie y protege comandos con Origin/CSRF antes del caso
de uso. Domain/Application no reciben cookies ni Request. K010 vuelve a comprobar
membership por operación; la lista de establecimientos de sesión no concede permisos.
La cabecera `X-Rescate-Dev-Actor` ya no autentica en runtime. Los tests unitarios
HTTP conservan un doble local; el recorrido real está en [K008](k008-identidad.md).

## Pruebas y límites

- `npm test`: reglas, requests HTTP, permisos, PATCH parcial, versión,
  inmutabilidad y errores con actor de prueba. Ajv 2020-12 valida las respuestas HTTP
  reales contra los schemas del YAML, sin copiar un catálogo alternativo.
- `api:contract:check`: Redocly comprueba estructura/ejemplos, no runtime.
- `api:types` / `api:types:check`: genera/verifica DTO con json-schema-to-typescript.
  YAML, Ajv y generador solo son dependencias de desarrollo. No se cambió el
  TypeScript existente ni se forzaron peers incompatibles.
- `db:test:lots:compose`: PostgreSQL real, IDs, permisos, conflictos concurrentes,
  edición contra publicación, rollback después de escritura y migraciones aditivas.
- `db:test:compose`: historial desde base vacía y rollback/reaplicación.

Las bases dedicadas conservan datos ficticios; no se migra ni revierte la base
de desarrollo. La [evidencia](k010-evidencia.md) separa ejecución original de
reconciliación. K008 agrega validación HTTPS/Chromium, sesiones, Origin/CSRF y
recorrido real hasta K010. La integración de pantallas K009/K011 sigue pendiente.
