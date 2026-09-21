# Contrato HTTP de S02

[openapi.yaml](openapi.yaml) es la **fuente de verdad HTTP** para K008–K011:
OpenAPI **3.1.0**, versión inicial del contrato **0.1.0**, un solo archivo.
Se prepara después de [ADR 0003](../adr/0003-arquitectura-incremental-s02.md) y
antes de implementar esas tarjetas. K010 ahora implementa las cuatro operaciones
de lotes con PostgreSQL, además de [`GET /health`](../../api/src/app.ts).
K008 (sesión, Origin y CSRF) sigue pendiente; el actor temporal solo sirve para
desarrollo. El YAML se conserva sin cambios respecto de development; sus notas
iniciales describen el contexto de adopción, no el avance actual.

OpenAPI define transporte, seguridad, requests, responses y errores. Las
[migraciones](../../api/migrations) definen persistencia; Domain y la documentación
conservan las reglas de negocio. Este archivo no genera SQL ni diseña repositories.
Los PDF E1 son históricos; los ADR prevalecen solo donde modifican explícitamente
sus reglas. [K004](../contrato-api.md) queda como antecedente, no contrato paralelo.

## Leer, validar y actualizar

Leer `paths` para operaciones y `components` para seguridad, parámetros, headers,
respuestas y schemas reutilizables. Los ejemplos son ficticios. La base `/api`
es la del proxy web; Vite quita ese prefijo al reenviar a Express. Un despliegue
con otra base debe configurar el cliente, no duplicar `/api` en cada ruta.

Desde la raíz, con Node 24.14.0 y npm 11 (mismo Node que CI):

```sh
npm --prefix api ci
npm --prefix api run api:contract:check
```

Se usa **@redocly/cli 2.53.3**, devDependency exacta con lockfile. Se revisaron los
paquetes de api/web: no había validador OpenAPI; el Ajv 6 transitivo de herramientas
web no constituye validación OpenAPI 3.1. Redocly ofrece en un CLI local validación
YAML, estructura, referencias y ejemplos, sin servicio externo ni framework en
runtime. Su paquete exige Node >=22.12 y npm >=10, compatible con API/CI; aquí se
probó en Node 24.14.0/npm 11.19.0. La instalación añadió un paquete distribuido con
sus dependencias empaquetadas; no se incorpora generador, portal ni servidor de mocks.

[redocly.yaml](redocly.yaml) es configuración del validador, no otro fragmento del
contrato. Parte de reglas mínimas y eleva a error estructura, referencias, ejemplos,
operationId, parámetros de ruta y seguridad. Los objetos del contrato se cierran
explícitamente con `additionalProperties: false`; el validador de ejemplos no
inyecta cierres adicionales dentro de los condicionales `if/then/else`.
La telemetría se desactiva en el script. No requiere login a Redocly.

Fuentes de herramienta: [CLI oficial](https://github.com/Redocly/redocly-cli),
[lint](https://redocly.com/docs/cli/commands/lint),
[ejemplos OpenAPI 3.1](https://redocly.com/docs/cli/rules/oas/no-invalid-media-type-examples)
y [especificación 3.1.0](https://spec.openapis.org/oas/v3.1.0.html).

Para modificar el contrato: contrastar E1/ADR, editar YAML y ejemplos juntos,
registrar decisiones nuevas aquí, valorar compatibilidad de consumidores y ejecutar
el check más `git diff --check`. No cambiar silenciosamente una regla de producto.
No dividir el YAML sin necesidad. El job API del [CI](../../.github/workflows/ci.yml)
ejecuta el mismo check después de `npm ci`; un error impide pasar ese job.

**Validación actual K010:** Redocly comprueba estructura y ejemplos; los tests HTTP
validan además status, `Cache-Control` y cuerpos reales con Ajv 2020-12 contra los
schemas del YAML, incluidas respuestas de error y el condicional de publicación.
`npm run api:types` deriva DTO mediante json-schema-to-typescript; `api:types:check`
detecta desincronización en CI. YAML, generador y Ajv son dependencias de desarrollo,
no middleware ni un framework de runtime. Los tipos no validan entradas por sí solos.
Las pruebas PostgreSQL verifican autorización, versión, rollback y concurrencia.
K008/K012 deben probar sesión, Origin/CSRF, cookies y recorrido completo de navegador;
no se afirma conformidad de seguridad todavía.

## Operaciones, seguridad y trazabilidad

Se conservan las cuatro rutas de identidad de K004. Se adoptan las cuatro rutas
de lotes propuestas: representan el establecimiento autorizado al crear y el lote
al consultar/editar/publicar. `/lots` mantiene el inglés de los modelos TypeScript y
SQL. `/lotes` es navegación de la web y propuesta HTTP histórica, sin consumidor de
negocio existente: no obliga a conservar esa ruta como API. El GET de lote es
**consulta para operador**; no implementa descubrimiento público RF03.

En la tabla, **C** significa header `X-CSRF-Token`, cookie CSRF y `Origin` permitido.
**G** significa respuestas generales `429`, `500`, `503`. **J** significa errores de
cuerpo JSON `400`, `413`, `415`, `422`; no sustituyen errores de autorización.

| operationId / método y ruta | Autenticación | CSRF | Respuestas | RF / tarjeta |
| --- | --- | --- | --- | --- |
| `register` · POST `/auth/register` | Pública | C | 201, 403, 409, J, G | RF01 / K008–K009 |
| `login` · POST `/auth/login` | Pública | C | 200, 401, 403, J, G | RF01 / K008–K009 |
| `logout` · POST `/auth/logout` | Cookie de sesión | C | 204, 401, 403, G | RF01 / K008–K009 |
| `getSession` · GET `/auth/session` | Opcional | Obtiene token, no lo exige | 200, G | RF01 / K008–K009 |
| `createLotDraft` · POST `/establishments/{establishmentId}/lots` | Sesión y permiso sobre establecimiento | C | 201, 401, 403, 404, J, G | RF02, RF01 / K010–K011 |
| `getLot` · GET `/lots/{lotId}` | Sesión y permiso sobre establecimiento del lote | No, lectura | 200, 401, 403, 404, G | RF02, RF01 / K010–K011 |
| `updateLotDraft` · PATCH `/lots/{lotId}` | Sesión y permiso sobre establecimiento del lote | C | 200, 401, 403, 404, 409, J, G | RF02, RF01 / K010–K011 |
| `publishLotDraft` · POST `/lots/{lotId}/publish` | Sesión y permiso sobre establecimiento del lote | C | 200, 401, 403, 404, 409, J, G | RF02, RF01 / K010–K011 |

RF01/RF02 provienen de anexos A p. 1; las tarjetas se relacionan en el
[modelo inicial](../modelo-inicial.md), sección Fuera de K003, y en la planificación
de este trabajo. No se inventan nuevos IDs de requisitos.

## Sesión, establecimientos y CSRF

**E1 H p. 21:** sesión opaca persistida en PostgreSQL, duración de **12 horas**;
cookie **HttpOnly, Secure, SameSite=Lax**; comandos con token CSRF y validación de
origen. Registro usa correo y contraseña de al menos 12 caracteres, scrypt, sal
aleatoria y parámetros en configuración. Solo el mínimo de entrada aparece en el
schema; hashing, sal y almacenamiento nunca son respuestas HTTP. Sin JWT ni refresh.

**Decisiones técnicas S02 que concretan E1:**

- Cookie de autenticación `__Host-rescate_session`, `Path=/`, sin `Domain`,
  `Max-Age=43200`. Vencimiento absoluto en servidor, sin renovación al consultar.
  Login emite nueva credencial; registro no emite esa cookie ni inicia sesión.
- `GET /auth/session` responde 200 con `{session, csrfToken}`. `session=null`
  indica visitante o sesión vencida/inválida. Una sesión válida contiene usuario
  público, `expiresAt` y `operableEstablishments: [{id, name}]`, posiblemente vacío.
  Evita un endpoint adicional para el selector de establecimiento. La lista se
  obtiene de los permisos actuales; no incluye IDs internos de membresía.
- La habilitación administrativa después de contacto manual y la pertenencia
  múltiple vienen de RF01/H. La representación de la lista es técnica S02.
  Registro no acepta `establishmentId` ni roles. Cada operación vuelve a comprobar
  permisos en Application: la lista recibida por el navegador no concede autoridad.
- Todas estas respuestas llevan `Cache-Control: no-store`. La cookie de sesión
  solo viaja por `Set-Cookie`/`Cookie`, nunca como valor en JSON.

E1 exige CSRF, pero no define cómo obtener ni transportar el token. Adoptamos
**double-submit firmado** para cubrir también registro/login sin inventar una
sesión autenticada anónima ni otro endpoint:

1. El navegador consulta `GET /auth/session`. Recibe `csrfToken` y, si hace falta,
   cookie `__Host-rescate_csrf` con el mismo token, `HttpOnly; Secure; SameSite=Lax;
   Path=/; Max-Age=43200`, sin `Domain`. Un token válido se reutiliza, evitando
   invalidar otras pestañas por cada lectura. El contexto anónimo no concede
   identidad ni requiere registrar una sesión de usuario en PostgreSQL.
2. En cada comando, incluso register/login/logout, el navegador envía cookies y
   copia el token del JSON a `X-CSRF-Token`. HTTP exige un `Origin` exacto permitido
   por configuración (esquema/host/puerto); ausente, `null` o ajeno se rechaza con 403.
   No se usa `Referer` como sustituto ni CORS abierto con credenciales.
3. El servidor exige igualdad header/cookie y valida autenticidad, expiración y
   vínculo del token. No basta comparar dos valores arbitrarios. El token contiene
   un nonce aleatorio y expiración protegidos con firma HMAC mediante secreto de
   configuración; en sesión autenticada la firma se vincula además a esa sesión,
   sin incluir su credencial en el token. Antes de login se firma contexto anónimo.
   El formato binario/textual no es contrato: cliente trata el token como opaco.
4. Login rota cookie de sesión y token/cookie CSRF; el token anónimo deja de ser
   aceptable para comandos de esa sesión. La respuesta contiene el nuevo token.
   Su vencimiento no supera el de la sesión. Obtener otro token no extiende sesión.
5. Logout revoca la sesión actual y elimina ambas cookies con `Max-Age=0` y los
   mismos atributos. Responde 204 sin body; reintentar sin sesión válida da 401.
   Después de logout, expiración o cambio de identidad se consulta otra vez sesión.
   Ante 403 se permite recargar contexto y revisar, no reenviar escrituras a ciegas.

La firma vinculada a la sesión sigue el patrón descrito por
[OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#signed-double-submit-cookie-recommended).
Se elige para evitar persistencia adicional del contexto previo a login. Es una
decisión técnica S02; E1 exige protección pero no prescribe este patrón.

Los dos `Set-Cookie` de login/logout se emiten como líneas independientes, nunca
como una lista separada por comas. OpenAPI documenta un Header Object para ese
nombre y describe sus dos instancias. CSRF aparece como parámetros requeridos,
no como alternativa de autenticación a la cookie de sesión.

HTTPS y mismo origen web/API mediante proxy son el objetivo de este contrato.
El Compose HTTP actual no demuestra cookies Secure: K008/K009 deben preparar y
probar un entorno HTTPS local. No se rebaja `Secure` silenciosamente. El frontend
conservará el token CSRF en memoria y no registrará tokens/contraseñas en logs.

## Campos, concurrencia y publicación

`CreateLotDraftRequest` exige contenido (`description`), categoría, cantidad,
dirección, coordenadas WGS84, zona IANA e inicio/fin de ventana. No hay título
inventado, propietario asignable ni campos del servidor. `conditions` es opcional:
omitirlo al crear equivale a null. Los campos mínimos del borrador están completos;
no se admite autosave de un formulario incompleto.

`UpdateLotDraftRequest` exige `version` y al menos un campo editable. Omitir un
campo conserva su valor; `conditions: null` quita indicaciones particulares.
El PATCH puede ser parcial, pero el borrador resultante sigue completo y válido.
La dirección/ubicación/zona son instantánea del lote, no una referencia mutable a
los valores actuales del establecimiento. La ventana exige fin posterior al inicio;
al publicar, el cierre también debe seguir siendo futuro según el reloj servidor.
No se impone ventana de máximo 24 h ni cantidad de máximo 100 del escenario de carga.

La versión nace en 1. Editar o publicar compara la versión esperada con la vigente
y aumenta en 1 dentro de la misma unidad atómica que la mutación. Un conflicto de
versión o estado produce **409 / CONFLICT** sin cambios. El frontend debe volver a
leer y permitir revisión, nunca sobrescribir automáticamente. También aumenta al
aceptar un PATCH cuyos valores coincidan con los existentes: cuenta comandos
aceptados y evita semántica especial de no-op.

`POST /lots/{lotId}/publish` solo recibe la versión revisada. El servidor comprueba
permiso, estado draft, versión y reglas, asigna `publishedAt` y devuelve el lote
publicado después de confirmar. Editar un publicado o volver a publicarlo da 409.
Si se pierde la respuesta, GET permite revisar estado/versión; no se promete
repetición idempotente del 200. Crear borrador tras respuesta perdida puede duplicar
una intención: no reintentar automáticamente; no se añade infraestructura de claves
anticipada. H p. 20 exige claves para asignación/incidencias, fuera de este alcance.

Cantidad, contenido, lugar y plazo publicados quedan fijos. Para corregir se debe
retirar y crear otro según RF02; el endpoint de retiro queda fuera de este contrato.
`LotResponse` solo añade id público, establecimiento, estado, versión, `createdAt`
y `publishedAt`; no expone todas las columnas ni inventa `updatedAt`.

**Fotos:** cero fotos permite publicar. Este contrato no recibe archivos, keys,
URLs ni IDs de imágenes, y no define pipeline ni endpoints de K014. La representación
HTTP de fotos se incorporará con esa tarjeta. Si existen asociaciones, solo imágenes
listas/validadas pueden ser visibles; publicación debe verificarlo sin llamadas
externas bajo bloqueo. E1 I p. 25 conserva hasta tres fotos, acceso autorizado y
contenido fijo tras publicación; omitir su transporte aquí no elimina RF02.

## Errores y límites

Envoltura única: `{error: {code, message, details?}}`. `code` es estable; `message`
es texto humano. `details.issues` contiene JSON Pointer y mensaje por campo, sin
copiar el valor rechazado. No hay SQL, trazas, hashes, secretos ni claves de objetos.

| Estado | code | Distinción |
| --- | --- | --- |
| 400 | `MALFORMED_REQUEST` | No se puede interpretar la solicitud/JSON |
| 401 | `UNAUTHENTICATED` | Falta sesión válida o credenciales de login incorrectas |
| 403 | `FORBIDDEN` | Permiso, origen o CSRF rechazado |
| 404 | `NOT_FOUND` | Objeto inexistente |
| 409 | `CONFLICT` | Correo duplicado, versión o estado incompatible según operación |
| 413 | `PAYLOAD_TOO_LARGE` | JSON mayor de 16384 bytes |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Body que no usa application/json |
| 422 | `VALIDATION_ERROR` | JSON interpretable que incumple tipos/campos/reglas |
| 429 | `RATE_LIMITED` | Límite de E1 H p. 21; `Retry-After` en segundos |
| 500 | `INTERNAL_ERROR` | Fallo inesperado, mensaje público genérico |
| 503 | `SERVICE_UNAVAILABLE` | Dependencia temporalmente indisponible |

E1 H p. 20 fija JSON 16 KB (S02 concreta 16384 bytes) y descripción de 2000
caracteres. H p. 21 fija 120 solicitudes/minuto/usuario con ráfaga 20 y
3000/minuto/IP con ráfaga 100; login bloquea 15 minutos tras cinco fallos por cuenta
en 15 minutos y admite hasta 30 intentos/IP en 15 minutos. Documentar 429 no
implementa limitadores. 400/413 de errores originados fuera de Express deberán
revisarse también en el proxy cuando exista, sin filtrar diagnósticos internos.

## Decisiones, fuentes y puntos abiertos

Se revisaron directamente el texto completo del informe (5 páginas) y anexos
A–I (28 páginas), extraído de los PDF con PyMuPDF fuera del repositorio. Se
inspeccionaron visualmente anexos pp. 10–17, 21 y 25 para diagramas, maquetas y
seguridad/fotos. No se modificaron los PDF. También se leyeron AGENTS, índice,
arquitectura, ADR 0001–0003, K003, K004, estructuras api/web, SQL, paquetes y CI.

| Decisión | Procedencia |
| --- | --- |
| Registro, login y logout separados; habilitación manual y varios establecimientos | RF01, anexos A p. 1/H p. 21; instrucción S02 confirma registro sin login |
| Sesión opaca PostgreSQL, 12 h, atributos de cookie, CSRF/origen, contraseña y scrypt | Anexos H p. 21 |
| Campos del pack, publicación e inmutabilidad | Anexos A p. 1, B p. 4 y G pp. 12/15; K003 concreta su representación |
| Versión optimista y rechazo por conflicto | Anexos C p. 5; S02 elige campo `version` y respuesta 409 |
| PK internas bigint e IDs públicos opacos; cantidades enteras positivas | Anexos B p. 4; representación pública concreta aún no elegida |
| Descripción hasta 2000 caracteres y cuerpo hasta 16 KB | Anexos H p. 20 |
| Fotos opcionales, solo listas visibles, fijas al publicar | Anexos I p. 25 |
| Borrador completo sin autosave incompleto | Decisión explícita de este trabajo S02; no atribuirla a E1 |
| Condiciones particulares opcionales/null | Decisión explícita de Producto durante esta revisión, 2026-09-21 |
| Normalizar correo igual en registro/login: trim exterior + minúsculas, preservar puntos y sufijos + | Decisión explícita de Producto durante esta revisión, 2026-09-21; requiere resolver unicidad normalizada al implementar K008 |
| Nombres HTTP, schemas, errores, cookie concreta, bootstrap/CSRF firmado, session=null, lista de establecimientos, reglas PATCH | Decisiones técnicas S02 de esta guía, no citas literales de E1 |

**BLOCKING DECISIONS:** condiciones y comparación del correo se identificaron y
quedaron resueltas explícitamente por Producto en esta revisión. No quedan bloqueos
para este contrato mínimo. La única representación provisional de producto es
`Category`: texto no vacío heredado de K003. **BLOCKING DECISION para fijar un
catálogo/enum de categorías:** E1/K003 no lo definen; detener esa parte hasta
acordarlo, sin inventar opciones ni impedir avanzar con texto. El ejemplo
“Panadería” ilustra texto, no establece un catálogo.

`PublicId` es string opaco sin UUID ni patrón de prefijo; la generación/migración
concreta es UUID persistido para lotes/establecimientos en K010; usuarios
corresponden a K008. El cliente sigue tratando esos valores como opacos. El contrato no permite usar las PK bigint
como string público. Tampoco elige granularidad de roles ni un flujo de administración:
la lista solo representa establecimientos que ya se pueden operar.

## Tipos, implementación futura y E2

Los dos catálogos TypeScript de web siguen siendo **antecedentes sin consumidores
de negocio**, no tipos derivados ni fuentes de verdad. Se marcan como históricos;
no se actualizan a mano para copiar el YAML. K009/K011 deberán introducir generación
desde OpenAPI y reemplazar/consolidar esos archivos al conectar consumidores. La
integración de tipos web queda pendiente; API ya genera sus DTO desde el YAML.
No se exporta un cliente ficticio.
Los tipos internos de Application/Domain seguirán siendo propios y no modelos SQL.

Para E2 se preparará una fila por operationId con enlaces reales a:
**OpenAPI → HTTP handler → Application use case → Domain/port/Infrastructure → test**.
K010 aporta esos eslabones para las cuatro operaciones de lotes, con evidencia
de autorización, transacciones, errores y respuestas contra el contrato. Las cuatro
operaciones de identidad y su protección siguen pendientes de K008. K009/K011 demostrarán formulario, selección
de establecimiento, cookie/CSRF y conflicto visible. Escenarios necesarios:
registro sin login/membresía, sesión vencida, acceso ajeno, CSRF/origen inválidos,
dos ediciones con misma versión, edición contra publicación y publicación sin fotos.

Nada de esto acredita todavía el Walking Skeleton ni toda E2: E1 incluye además
búsqueda/reserva/fotos. Se posponen handlers de identidad, credenciales reales,
persistencia de sesiones y protección CSRF/origen, K014, descubrimiento, reserva,
FIFO/ofertas, cancelación/retiro, chat, incidencias,
worker y estadísticas. ADR 0001 y ADR 0002 se conservan sin modificaciones.

## Verificación histórica de adopción del contrato (2026-09-21)

Registro previo a K010; ver [evidencia K010](../k010-evidencia.md) para la
reconciliación y pruebas nuevas. No describe el estado actual de implementación.

| Comprobación ejecutada | Resultado observado |
| --- | --- |
| `npm ci` en API | Instalación reproducible del lockfile, exit 0 |
| `npm run api:contract:check` en API | YAML, OpenAPI 3.1.0, referencias y ejemplos válidos, exit 0 |
| Redocly `bundle` hacia `/tmp` | Resolución de referencias completada; sin artefacto generado en el repositorio |
| Diez copias inválidas en `/tmp`, con el mismo CLI/config | Las diez rechazadas con exit 1: YAML, referencia, estructura, cantidad cero, auto-membership, contraseña corta, ID numérico, timestamp de publicación en draft, propiedad interna extra y PATCH con solo versión |
| `npm run typecheck`, `npm test`, `npm run build` en API | Exit 0; una prueba de `/health`, ninguna prueba de identidad/publicación real |
| `npm run typecheck`, `npm run lint`, `npm run build` en web | Exit 0; los cambios TypeScript son comentarios de estado histórico |
| Enlaces locales de los Markdown modificados/nuevos | 81 destinos existentes |
| Mermaid de arquitectura/modelo | Tres bloques idénticos a HEAD y revisados; no se afirma una nueva ejecución de renderizado |
| Revisión estática de seguridad/alcance | Seis comandos con origen/CSRF; registro sin cookie de sesión ni membresía; IDs opacos, versiones y publicación explícita; fotos no requeridas; sin campos persistidos internos ni credenciales reales detectadas |

La primera prueba de salud falló dentro del sandbox; al permitir el puerto local
pasó, también después de `npm ci`. No se ejecutó GitHub Actions remoto ni se repitió
Compose/migraciones/B2, cuyo código y configuración operativa no cambian aquí.
La evidencia estructural no demuestra autorización, transacciones ni CSRF ejecutados.
