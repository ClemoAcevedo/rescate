# K011 — Formulario de lote del operador

Implementación en el árbol de trabajo, 2026-09-26 (RF02). [OpenAPI S02](api/openapi.yaml)
es la fuente de verdad HTTP; K010 implementa las operaciones y K008 la sesión/CSRF.
Esta tarjeta conecta la web con esas cuatro operaciones de lotes, sin cambiar el contrato.

## Implementado

| Ruta web | Resultado |
| --- | --- |
| `/operador/lotes/nuevo` | Formulario completo; «Guardar borrador» crea el lote (`createLotDraft`) y navega a su ruta. |
| `/operador/lotes/:lotId` | Carga con `getLot`; edita el borrador (`updateLotDraft`) y publica (`publishLotDraft`). Un lote publicado se muestra en solo lectura. |

- La cabecera muestra «Publicar lote» solo si la sesión tiene `operableEstablishments`.
  Es orientación de navegación: la API vuelve a comprobar la membresía en cada operación.
- Sin sesión se ofrece iniciar sesión y volver al formulario (`/login?from=`). Una cuenta
  sin establecimientos operables recibe una explicación, no un formulario.
- El establecimiento se elige con un campo que filtra por texto (primitive `Combobox`),
  pensado para cuentas con muchos establecimientos; con uno solo, queda preseleccionado.
  Se elige solo al crear: OpenAPI no permite reasignarlo.
- `/lotes` y `/lotes/:id` siguen siendo las demostraciones de exploración (RF03, fuera de K011).

## Decisiones respecto del contrato

| Tema | Decisión | Fuente |
| --- | --- | --- |
| Tipos HTTP | `api:types` escribe la misma salida en `api/src/http/openapi.ts` y `web/src/services/openapi.ts`; `api:types:check` verifica ambos en CI. La web compila y se construye por separado, por eso recibe una copia generada y no importa desde `api/`. | AGENTS.md, ADR 0003 |
| Parser de runtime | `lots-service.ts` valida `LotResponse`, incluido el condicional `status`/`publishedAt`. Los tipos no validan datos por sí solos. | [services](../web/src/services/README.md) |
| Borrador completo | Todos los campos son obligatorios salvo `conditions`; condiciones vacías se envían como `null`. No hay autosave. | `CreateLotDraftRequest` |
| Coordenadas y zona | Se piden en el formulario: la sesión solo entrega `{id, name}` del establecimiento y no existe otra operación que los proporcione. «Usar mi ubicación actual» completa latitud/longitud con la geolocalización del navegador (permiso explícito, HTTPS), sin llamar a la API; el operador revisa antes de guardar. La zona se elige con el mismo filtro por texto y parte en `America/Santiago` (la del lugar de retiro, no la del navegador del operador). | `OperableEstablishment`, `TimeZone` |
| Ventana de retiro | La hora se escribe en la zona IANA del lote y se envía en RFC 3339 con offset explícito (`2031-01-15T18:00:00-03:00`). Una hora inexistente por cambio de horario se rechaza antes de enviar. | `Instant` |
| Edición | PATCH lleva `version` y solo los campos modificados; los instantes se comparan por valor. | `UpdateLotDraftRequest` |
| Conflicto | Un 409 conserva lo escrito y ofrece «Recargar lote» (GET). No se reenvía ni sobrescribe automáticamente. | descripción de `updateLotDraft` |
| Publicación | Solo `{ version }`, con confirmación explícita. Queda deshabilitada mientras haya cambios sin guardar, para publicar exactamente la versión revisada. | `PublishLotDraftRequest` |
| Respuesta perdida | Si un comando no recibe una respuesta válida, se explica que pudo aplicarse y se ofrece consultar el lote, sin reintento automático. | descripción de `publishLotDraft` |
| Fotos | Bloque «Pendiente de validación» sin input de archivos ni llamadas HTTP. OpenAPI no admite cargas ni referencias de fotos en este alcance; publicar sin fotos es válido. | `createLotDraft`, K014/K017 |

Cantidad, latitud y longitud son campos de texto que ignoran cualquier cambio no numérico
al escribir o pegar (`type="number"` admite «e», «+» y «-» en Chrome y texto libre en
Safari/Firefox). Se rechaza el cambio completo en vez de quitar caracteres, para que «1.5»
no se convierta en 15; la coma decimal se toma como punto. Las coordenadas no usan
`inputMode="decimal"` porque el teclado de iOS no ofrece el signo menos.

La validación local (campos vacíos, rangos, ventana ordenada) solo evita envíos que la
API rechazaría; la validez la decide el servidor. Los 422 se muestran en el campo que
indica `details.issues[].path` (JSON Pointer) y el foco pasa al primer campo señalado.
Un único estado de envío, respaldado por un ref, deshabilita las acciones y evita dobles
envíos antes del siguiente render.

## Archivos

| Archivo | Responsabilidad |
| --- | --- |
| [lots-service.ts](../web/src/services/lots-service.ts) | Las cuatro operaciones, CSRF por header, parser y errores tipados. |
| [openapi.ts](../web/src/services/openapi.ts) | Tipos generados; no editar a mano. |
| [lot-form.ts](../web/src/lots/lot-form.ts) | Valores del formulario ↔ cuerpos del contrato, cambios para PATCH y errores por campo. |
| [lot-time.ts](../web/src/lots/lot-time.ts) | Conversión de hora local de la zona del lote a RFC 3339, solo con `Intl`. |
| [LotEditorPage.tsx](../web/src/pages/LotEditorPage.tsx) | Sesión, carga, guardado, publicación, mensajes y foco. |
| [LotForm.tsx](../web/src/components/lots/LotForm.tsx), [LotSummary.tsx](../web/src/components/lots/LotSummary.tsx), [LotPhotosPending.tsx](../web/src/components/lots/LotPhotosPending.tsx) | Campos con primitives UI, vista publicada y aviso de fotos. |
| [Combobox.tsx](../web/src/components/ui/Combobox.tsx) | Primitive de selección con filtro por texto (establecimiento y zona horaria), reutilizable fuera de lotes. |
| [UseCurrentLocation.tsx](../web/src/components/lots/UseCurrentLocation.tsx) | Geolocalización del navegador para latitud/longitud, con mensajes de permiso denegado, tiempo agotado o indisponible. |
| [test-web-lots.mjs](../api/scripts/test-web-lots.mjs) | Recorrido real en Chromium. |

## Evidencia reproducible

Requiere API, Vite HTTPS y una base de prueba ya migrada, iniciados explícitamente como
en [web/README](../web/README.md#identidad-k008-k009). `DATABASE_URL` debe ser la misma
base de la API: la prueba inserta un establecimiento y membresías ficticios por SQL,
porque no existe una operación para habilitar operadores.

```sh
DATABASE_URL=postgres://… WEB_URL=https://localhost:5174 npm --prefix api run test:web:lots
```

| Comprobación | Resultado |
| --- | --- |
| Visitante y cuenta sin membresía | Sin formulario; enlace de login con retorno y explicación de habilitación. |
| Zona horaria | «lima» filtra a `America/Lima`; Enter y clic seleccionan; por defecto `America/Santiago`. |
| Establecimiento | Con tres establecimientos: sin preselección; guardar sin elegir marca el campo y lo enfoca; «cafe nunoa» encuentra «Café Ñuñoa»; Enter y clic seleccionan; texto sin coincidencias limpia la selección. |
| Ubicación actual | Permiso denegado explicado sin cambiar campos; con permiso completa latitud/longitud (6 decimales) sin llamar a la API. |
| Campos numéricos | Letras y valores como «1.5» en cantidad o «-33.4a5» en latitud se ignoran al escribir o pegar; «-33,451» se acepta como -33.451. |
| Validación local | Errores por campo, foco en el primero y ningún comando enviado. |
| Crear | POST 201 con el cuerpo exacto del contrato (offset `-03:00`, `conditions: null`); persiste tras recargar. |
| Editar | PATCH solo con `version` y el campo cambiado; publicar exige guardar antes. |
| Conflicto | Edición concurrente real → 409; lo escrito se conserva hasta «Recargar lote» (versión 3). |
| Publicar | Confirmación explícita; doble clic produce un solo POST; vista de solo lectura tras recargar. Republicar responde 409. |
| Validación del servidor | Publicar una ventana vencida → 422 `VALIDATION_ERROR`, mostrado en `pickupEndsAt`. |
| Lote inexistente | 404 explicado sin formulario. |
| Layout | Sin scroll horizontal en 360×800 y 1366×768 (capturas revisadas). |
| Robustez | Sin errores de página ni respuestas 429. |

K008 limita a 20 solicitudes en ráfaga por usuario. Una primera versión de la prueba
recibió 429 al publicar al final del recorrido; los casos de 422 y 404 usan una segunda
cuenta con su propia cuota. La UI mostró correctamente el aviso de límite en ese caso.

### Resultado local, 2026-09-26

Node 22.18.0 (CI usa 24.14.0) y PostgreSQL 14.17 temporal en el puerto 55432 con todas
las migraciones aplicadas (el proyecto usa 16 en Compose; Docker no estaba disponible).
API HTTP en 3001, Vite HTTPS en 5174 con certificado efímero. Tres ejecuciones seguidas
de `test:web:lots` aprobadas; tras agregar «Usar mi ubicación actual» se repitió el
recorrido completo, también aprobado.

- Web: typecheck, lint y build aprobados.
- API: typecheck, 36 tests, build, `api:types:check` y `api:contract:check` aprobados.
- `git diff --check` sin errores.

Son resultados locales sobre datos ficticios; no representan CI remoto ni despliegue.

## Limitaciones conocidas y alternativas

### Coordenadas del lugar de retiro

OpenAPI (`CreateLotDraftRequest`) y el modelo K003 (`lots.latitude/longitude` NOT NULL,
instantánea del lote) exigen coordenadas. Pedirlas a mano no es realista para un
operador. K011 no cambia el contrato; implementa la alternativa B y propone las demás:

| Alternativa | Contrato | Estado y valoración |
| --- | --- | --- |
| B. Botón «Usar mi ubicación actual» (geolocalización del navegador) | Sin cambios | **Implementada en K011.** Sin dependencias; solo sirve si el operador está en el lugar de retiro, y la dirección sigue siendo manual. |
| A. Precargar dirección, coordenadas y zona desde el establecimiento | Requiere ampliar `OperableEstablishment` u otra operación en OpenAPI | Mejora necesaria de experiencia: `establishments` ya guarda esos datos. Debe acordarse como cambio de contrato. |
| C. Geocodificar la dirección o elegir en un mapa con proveedor externo | Sin cambios en OpenAPI; nueva dependencia externa | Necesaria en algún momento; exige decidir proveedor, claves, privacidad y costo. |

### Recuperar un borrador

OpenAPI no define un listado de lotes (K010 retiró `GET /lots`). Un borrador solo se
recupera con su URL `/operador/lotes/:lotId`; si se pierde el enlace, no hay forma de
encontrarlo desde la web. K035 (S06) contempla mostrar lotes por establecimiento, pero
queda lejos. Se propone una tarjeta propia con una operación de listado por
establecimiento en OpenAPI, backend y web.

## Deuda técnica registrada

- K009 declara a mano sus tipos de identidad en `identity-service.ts`; deberían importarse
  de `openapi.ts`. No se modificó en K011 para no mezclar alcances.
- El parser de errores `{error:{code,message,details}}` está duplicado entre identidad y
  lotes. Unificarlo requiere tocar K009.
- `types/api.ts` y `services/api-types.ts` (K004) siguen como antecedentes sin consumidores.
- Fotos: el bloque queda como aviso hasta K014 (validación) y K017 (integración).
- Escala de establecimientos: el filtro opera sobre `operableEstablishments`, que
  `GET /auth/session` entrega completo. Con miles de membresías convendría búsqueda o
  paginación en el servidor, lo que requiere un cambio de contrato.
- Listado de lotes por establecimiento para recuperar borradores (ver
  [Recuperar un borrador](#recuperar-un-borrador)); candidata a tarjeta propia.
- Ingreso de ubicación cuando el operador no está en el local: alternativas A y C de
  [Coordenadas del lugar de retiro](#coordenadas-del-lugar-de-retiro) (B ya implementada).
