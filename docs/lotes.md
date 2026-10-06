# Lotes, búsqueda y reserva directa (RF02–RF04)

Un operador crea un borrador de lote para un establecimiento del que es miembro,
lo edita y lo publica. Lo publicado no cambia. El contrato HTTP está en
[OpenAPI S02](api/openapi.yaml); este documento explica reglas, decisiones y
cómo probarlo. La sesión, las cookies y el CSRF están en [K008](k008-identidad.md).

## Reglas de negocio

- **Borrador completo.** No se guardan formularios a medias. Son obligatorios
  descripción (hasta 2000 caracteres), categoría (texto libre), cantidad (entero
  positivo), dirección, coordenadas, zona horaria IANA y ventana de retiro.
  `conditions` es opcional (`null`).
- **Versión optimista.** Cada edición y la publicación reciben la `version`
  leída; una versión obsoleta responde 409. Un PATCH aceptado incrementa la
  versión aunque el valor no cambie.
- **Publicar** exige que la ventana termine después de su inicio y después del
  instante del servidor, comprobado bajo bloqueo del lote; si no, 422. Cero
  fotos permite publicar; si hay fotos, todas deben estar listas o responde 422
  ([fotos](fotos.md)).
- **Fotos fijas.** Publicado, no se agregan ni quitan fotos (409).
- **Inmutabilidad.** Un lote publicado no se edita ni se republica (409):
  cantidad, contenido, lugar y plazo quedan fijos.
- **Autorización del operador.** Cada operación de borrador/publicación comprueba la membership actual sobre el
  establecimiento del lote. La lista de establecimientos de la sesión solo orienta
  la navegación; los UUID públicos no conceden permisos.

## Contrato HTTP

| Método | Ruta | Resultado |
| --- | --- | --- |
| GET | `/establishments/:establishmentId/lots` | 200, lotes del establecimiento para su operador |
| POST | `/establishments/:establishmentId/lots` | 201, borrador versión 1 |
| GET | `/lots/:lotId` | 200, lote del operador autorizado |
| PATCH | `/lots/:lotId` | 200, versión incrementada |
| POST | `/lots/:lotId/publish` | 200, publicado |

Las rutas son relativas a la base de la API; el proxy de la web quita `/api`. La búsqueda pública usa rutas separadas.

- El listado exige membership actual sobre el establecimiento (403 para otro
  operador, 404 si el establecimiento no existe). Incluye borradores y publicados,
  también con la ventana vencida, ordenados por publicación o creación descendente,
  en páginas de 20. Filtra con `status=draft|published`; un filtro desconocido
  responde 422. Cada resumen trae los packs reservados y la miniatura de la primera
  foto lista.

- PATCH recibe `version` y al menos un campo. Omitir un campo lo conserva;
  `conditions: null` lo borra. Application combina el patch con la declaración
  leída bajo bloqueo y Domain valida el resultado completo.
- Publicar recibe solo `{ "version": N }`.
- Se rechazan propiedades desconocidas, cambio de establecimiento y campos del
  servidor. Las fechas son RFC 3339 con zona explícita; las respuestas usan UTC.
- Las respuestas exponen solo `LotResponse`, con `Cache-Control: no-store`. Los
  errores siguen `{error:{code,message,details?}}`, con `details.issues[].path`
  como JSON Pointer. Los códigos por operación están en OpenAPI.

## Backend

```text
HTTP → Application → Domain / ports → Infrastructure
             ↑ Composition ensambla dependencias concretas
```

- **HTTP** ([lots-router.ts](../api/src/http/lots-router.ts)) parsea, obtiene el
  Actor de la sesión y traduce errores.
- **Application** autoriza y define la unidad atómica `withLotTransaction`.
- **Domain** ([lots.ts](../api/src/domain/lots.ts)) contiene las reglas puras.
- **Infrastructure** abre la transacción, hace `SELECT … FOR UPDATE`, consulta la
  membership y escribe con el mismo cliente. La versión se compara después del
  bloqueo, así que de dos comandos con la misma versión solo uno confirma. Un
  fallo después de escribir revierte todo. No hay llamadas externas bajo bloqueo.

**Identificadores.** `lots.public_id` y `establishments.public_id` son UUID
persistidos; las PK internas nunca salen por HTTP. Un texto que no es UUID no
identifica un establecimiento y responde 404.

## Web del operador

| Ruta | Qué hace |
| --- | --- |
| `/operador/lotes` | «Mis lotes»: borradores y publicados del establecimiento, con filtros Todos/Borradores/Publicados, reservas y acceso a la vista pública. Con varios establecimientos se elige uno. |
| `/operador/lotes/nuevo` | Formulario completo; «Guardar borrador» crea el lote y navega a su ruta. |
| `/operador/lotes/:lotId` | Carga, edita y publica el borrador; un lote publicado se muestra en solo lectura. |

La cabecera muestra «Mis lotes» y «Publicar lote» solo si la sesión tiene
establecimientos operables. Un lote publicado ofrece «Ver como rescatista» mientras
su ventana sigue abierta. Sin sesión se ofrece iniciar sesión y volver; una cuenta sin membership
recibe una explicación.

| Tema | Decisión |
| --- | --- |
| Tipos | `api:types` genera `web/src/services/openapi.ts`; `lots-service.ts` valida la respuesta en runtime. |
| Establecimiento y zona | `Combobox` con filtro por texto. El establecimiento se elige solo al crear; con uno solo queda preseleccionado. La zona parte en `America/Santiago`. |
| Coordenadas | Se ingresan a mano o con «Usar mi ubicación actual» (geolocalización del navegador, sin llamar a la API). Precargarlas desde el establecimiento requiere cambiar el contrato (#97). |
| Ventana de retiro | Se escribe en la zona del lote y se envía en RFC 3339 con offset. Una hora inexistente por cambio de horario se rechaza antes de enviar. |
| Campos numéricos | Ignoran cualquier cambio no numérico al escribir o pegar; la coma decimal se toma como punto. |
| Edición | PATCH con `version` y solo los campos modificados. |
| Conflicto | Un 409 conserva lo escrito y ofrece «Recargar lote»; no se reenvía solo. |
| Publicación | Con confirmación explícita y deshabilitada mientras haya cambios sin guardar. |
| Respuesta perdida | Se avisa que el comando pudo aplicarse y se ofrece recargar, sin reintento automático. |
| Envíos | Un solo comando a la vez; un ref evita dobles envíos antes del siguiente render. |
| Errores 422 | Se muestran en el campo indicado por `details.issues[].path` y el foco va al primero. |
| Fotos | Se cargan después de guardar el borrador; ver [fotos en el formulario](fotos.md#formulario-del-operador). Publicar se deshabilita mientras haya fotos no listas. |

Código principal: [lots-service.ts](../web/src/services/lots-service.ts),
[lot-form.ts](../web/src/lots/lot-form.ts), [lot-time.ts](../web/src/lots/lot-time.ts),
[use-lot-photos.ts](../web/src/lots/use-lot-photos.ts) y [LotEditorPage.tsx](../web/src/pages/LotEditorPage.tsx).

## Búsqueda y reserva directa

`/lotes` consulta la API sin sesión. Permite categoría, ubicación manual o del
navegador, radio y comienzo de la ventana de retiro. PostGIS usa `geography` WGS84:
`ST_DWithin` filtra el radio con índice GiST y `ST_Distance` ordena por distancia
geográfica, no tiempo de viaje. Cada página tiene hasta 12 lotes. Sin coordenadas
se ordena por publicación; fecha e ID desempatan. La disponibilidad puede cambiar
entre páginas y se vuelve a leer al reservar. El detalle excluye borradores y
lotes cerrados; los lotes sin stock muestran cero disponibles.
La web mantiene visibles esos lotes en lista y detalle, indica que no quedan
packs y oculta el formulario de reserva. `photoUrl` lleva a la miniatura en la lista;
el detalle muestra todas las fotos listas (`photos`) en una galería. Si falta una foto
o falla su carga, muestra un reemplazo local con texto alternativo.

El lote no tiene un campo de título. La web deriva uno corto de la descripción (el
texto antes del primer `: `, `. ` o salto de línea, si mide entre 8 y 70 caracteres)
para tarjetas y encabezados ([lot-title.ts](../web/src/lots/lot-title.ts)); el detalle
muestra la descripción completa en «Qué incluye».

La persona inicia sesión para reservar. El actor procede de K008, nunca del cuerpo.
Application coordina la transacción mediante `withReservationTransaction`:

1. Serializa la clave por actor y lee un resultado previo.
2. Si no existe, bloquea el lote con `FOR UPDATE`, lee el reloj de PostgreSQL y
   relee disponibilidad y compromiso activo. Si los reservados del lote no
   coinciden con sus reservas confirmadas, rechaza con 409 y registra
   `inventory_discrepancy` para revisión.
3. Domain exige packs enteros positivos, stock suficiente, ausencia de otro
   compromiso activo del mismo usuario/lote y un instante anterior al cierre.
4. Inserta reserva y clave y mueve la cantidad de libres a reservados (F → R), todo
   junto. HTTP responde solo después del commit.

La espera por cada bloqueo tiene un límite de 2 s. Si se supera, la transacción
revierte y responde 503; el mismo intento se puede repetir sin consumir su clave.

Se puede reservar antes del inicio del retiro. La cantidad publicada no cambia;
la disponibilidad es F, la columna de libres del lote. Los CHECK de la base impiden
que quede negativa ([ADR 0006](adr/0006-inventario-del-lote.md)). Aún no hay cola,
ofertas, cancelaciones, códigos ni retiros: cada uno moverá sus contadores bajo el
mismo bloqueo y la cola FIFO se atenderá según ADR 0002.

La clave UUID viaja en `idempotencyKey`. Un resultado confirmado reproduce el
mismo 201 y cuerpo con la misma clave y parámetros, incluso tras cerrar el lote.
Cambiar lote o cantidad con esa clave da 409. Un error no consume la clave.
[ADR 0004](adr/0004-reserva-directa-idempotente.md) explica la persistencia.

El navegador espera hasta 10 s por intento y reintenta fallos inciertos hasta tres
veces a 1, 2 y 4 s, conservando clave y cantidad. Mientras envía o queda un resultado
incierto, bloquea el cambio de cantidad. No convierte un timeout en una reserva
fallida ni inicia otra intención en silencio. Esto incluye un 5xx del proxy aunque
su cuerpo no sea JSON. Tras confirmar, vuelve a consultar la disponibilidad para
incluir reservas de otras personas.

Recorrido: [router](../api/src/http/discovery-router.ts) →
[Application](../api/src/application/discovery/use-cases.ts) →
[reglas](../api/src/domain/reservations.ts) /
[PostgreSQL](../api/src/infrastructure/postgres/discovery-repository.ts).

## Datos de demostración

Con PostgreSQL de [Compose](desarrollo-local.md) y `DATABASE_URL` en `api/.env`
apuntando a una base local `rescate` o `rescate_*`:

```bash
npm --prefix api run db:migrate
npm --prefix api run db:seed:demo
```

| Cuenta | Establecimiento | Lotes |
| --- | --- | --- |
| `operador.norte@example.test` | Almacén Norte ficticio | Un borrador y uno publicado |
| `operador.sur@example.test` | Almacén Sur ficticio | Un borrador y uno publicado |
| `visitante@example.test` | Ninguno | Explora y reserva publicados; no opera borradores |

Contraseña de prueba: `Rescate-K012-solo-pruebas!`. Los ID están en
[demo-data.mjs](../api/fixtures/demo-data.mjs); los lotes se abren en
`/operador/lotes/{id}`.

La carga es transaccional y repetible: al repetirla verifica cuentas y permisos,
añade los lotes que falten y conserva ediciones y sesiones. Aborta si las cuentas o
sus permisos fueron modificados y rechaza `NODE_ENV=production`. Para renovar las
ventanas de retiro de los lotes semilla vencidos:

```bash
npm --prefix api run db:seed:demo -- --refresh-expired-lots
```

## Pruebas

Todas corren en CI. Los comandos `*:compose` necesitan el servicio `db` de Compose
y crean una base aislada que conservan para inspección.

| Comando | Qué comprueba |
| --- | --- |
| `npm --prefix api test` | Reglas, requests HTTP, permisos, PATCH parcial, versión, inmutabilidad y errores; Ajv valida las respuestas contra OpenAPI. |
| `npm --prefix api run db:test:lots:compose` | PostgreSQL real: IDs, permisos, listado por establecimiento y estado, conflictos concurrentes, edición contra publicación y rollback. |
| `npm --prefix api run db:test:auth:compose` | Sesión real hasta lotes por HTTPS; datos semilla, publicación por dos operadores y rechazo entre establecimientos y del visitante. |
| `npm --prefix api run db:test:discovery:compose` | Búsqueda PostGIS, filtros/páginas, último pack concurrente, reintentos, claves por actor, rollback y cierre tras esperar bloqueo. |
| `npm --prefix api run test:web:compose` | Chromium contra Vite HTTPS, la API y el worker de fotos: formularios, fotos del borrador (rechazo, lista, D-05 y publicación), galería pública, «Mis lotes» con filtros, búsqueda sin geolocalización, reserva real, respuesta perdida tras commit y layout sin scroll horizontal. |

## Limitaciones

- Las coordenadas no se precargan desde el establecimiento (#97). Geocodificar o
  elegir en un mapa requiere decidir proveedor, claves y costo.
- El filtro de establecimientos opera sobre la lista completa de la sesión (#99).
