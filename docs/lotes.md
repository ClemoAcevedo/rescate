# Lotes (RF02)

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
  fotos permite publicar.
- **Inmutabilidad.** Un lote publicado no se edita ni se republica (409):
  cantidad, contenido, lugar y plazo quedan fijos.
- **Autorización.** Cada operación comprueba la membership actual sobre el
  establecimiento del lote. La lista de establecimientos de la sesión solo orienta
  la navegación; los UUID públicos no conceden permisos.

## Contrato HTTP

| Método | Ruta | Resultado |
| --- | --- | --- |
| POST | `/establishments/:establishmentId/lots` | 201, borrador versión 1 |
| GET | `/lots/:lotId` | 200, lote del operador autorizado |
| PATCH | `/lots/:lotId` | 200, versión incrementada |
| POST | `/lots/:lotId/publish` | 200, publicado |

Las rutas son relativas a la base de la API; el proxy de la web quita `/api`.
PATCH recibe `version` y al menos un campo. Omitir un campo lo conserva;
`conditions: null` lo borra. Application combina el patch con la declaración
leída bajo bloqueo y Domain valida el resultado completo. Publicar recibe solo
`{ "version": N }`. Se rechazan propiedades desconocidas, cambios de
establecimiento y campos del servidor. Las fechas son RFC 3339 con zona explícita;
las respuestas usan UTC.

## Exploración y reserva directa

La lista y el detalle públicos muestran lotes publicados cuyo retiro no ha
terminado. El listado acepta categoría, punto WGS84 y radio (hasta 100 km),
inicio de retiro anterior a un instante y páginas de 12 resultados. Sin punto
se ordena por publicación reciente; con punto, por distancia geográfica
aproximada. La zona se escribe a mano o se completa con permiso del navegador;
denegarlo no limita la búsqueda.

La disponibilidad es cantidad declarada menos reservas confirmadas. Un lote
agotado sigue visible con «Sin stock»; abrir el detalle no reserva packs. La foto
visible es opcional: mientras no hay fotos integradas, la API devuelve `photoUrl`
null y la web muestra una imagen de reemplazo.

La reserva directa requiere sesión y CSRF. El caso de uso bloquea el lote,
relee las reservas, comprueba disponibilidad y un único compromiso activo por
persona/lote y confirma la cantidad solicitada en la misma transacción. Una clave
UUID por intención permite reintentar una respuesta incierta sin duplicar. Si
falta stock, responde 409 y la web vuelve a consultar el detalle. La espera FIFO,
ofertas y entregas siguen las reglas de [ADR 0002](adr/0002-ofertas-parciales.md)
cuando se implementen; esta operación solo confirma si hay stock suficiente.

Las respuestas del operador exponen `LotResponse`. Todas las respuestas llevan
`Cache-Control: no-store`; los errores siguen `{error:{code,message,details?}}`,
con `details.issues[].path` como JSON Pointer. Los códigos por operación están en
OpenAPI.

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
| `/operador/lotes/nuevo` | Formulario completo; «Guardar borrador» crea el lote y navega a su ruta. |
| `/operador/lotes/:lotId` | Carga, edita y publica el borrador; un lote publicado se muestra en solo lectura. |

La cabecera muestra «Publicar lote» solo si la sesión tiene establecimientos
operables. Sin sesión se ofrece iniciar sesión y volver; una cuenta sin membership
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
| Fotos | Solo un aviso «Pendiente de validación»; OpenAPI aún no admite fotos (K014/K017). |

Código principal: [lots-service.ts](../web/src/services/lots-service.ts),
[lot-form.ts](../web/src/lots/lot-form.ts), [lot-time.ts](../web/src/lots/lot-time.ts)
y [LotEditorPage.tsx](../web/src/pages/LotEditorPage.tsx).

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
| `visitante@example.test` | Ninguno | Sin acceso a lotes |

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

Las pruebas corren en CI. Los comandos `*:compose` necesitan el servicio `db` de
Compose y crean una base aislada que conservan para inspección. Los comandos de
descubrimiento reciben `DATABASE_URL` de una base aislada y migrada; el recorrido
web requiere además Vite HTTPS y la API con esa misma base.

| Comando | Qué comprueba |
| --- | --- |
| `npm --prefix api test` | Reglas, requests HTTP, permisos, PATCH parcial, versión, inmutabilidad y errores; Ajv valida las respuestas contra OpenAPI. |
| `npm --prefix api run db:test:lots:compose` | PostgreSQL real: IDs, permisos, conflictos concurrentes, edición contra publicación y rollback. |
| `npm --prefix api run db:test:auth:compose` | Sesión real hasta lotes por HTTPS; datos semilla, publicación por dos operadores y rechazo entre establecimientos y del visitante. |
| `npm --prefix api run test:web:compose` | Chromium contra Vite HTTPS y la API: formulario completo, conflicto, doble clic, 422, 404 y layout sin scroll horizontal. |
| `npm --prefix api run db:test:discovery` | Sobre una base K016 migrada: búsqueda anónima, login, reserva, reintento, agotamiento y competencia por el último pack. |
| `npm --prefix api run test:web:discovery` | Con Vite HTTPS, API y la misma base: exploración, geolocalización denegada, filtros manuales, detalle, login y reserva real. |

## Limitaciones

- El listado público no muestra borradores; un borrador solo se recupera con su URL
  de operador (#96).
- Las coordenadas no se precargan desde el establecimiento (#97). Geocodificar o
  elegir en un mapa requiere decidir proveedor, claves y costo.
- Sin fotos hasta K014/K017.
- El filtro de establecimientos opera sobre la lista completa de la sesión (#99).
