# K008 — Identidad, sesiones y conexión con K010

Implementación en el árbol de trabajo, 2026-09-21; sin commit, push ni despliegue.
[OpenAPI](api/openapi.yaml) manda sobre HTTP; [ADR 0003](adr/0003-arquitectura-incremental-s02.md)
sobre responsabilidades. Esta guía concentra operación, aprendizaje y evidencia K008.
Las mediciones originales de scrypt se conservan en la [guía HTTP](api/README.md#decisiones-de-infrastructure-k008--etapa-2-2026-09-21).

## Alcance implementado

| Operación | Resultado |
| --- | --- |
| POST `/auth/register` | Usuario + credencial atómicos; 201. No inicia sesión ni agrega membership. Duplicado canónico: 409. |
| POST `/auth/login` | Scrypt, protección de intentos y sesión persistente de 12 horas. Cookie opaca; JSON sin secreto. |
| GET `/auth/session` | Sesión pública o null, establecimientos actuales y CSRF. No renueva la sesión. |
| POST `/auth/logout` | Revoca solo la sesión presentada; elimina ambas cookies; 204 sin cuerpo. Reintento: 401. |
| K010 | Sesión → Actor interno → autorización por membership. Comandos con Origin/CSRF. |

Frontend K009/K011, workflow administrativo, recuperación de contraseña, reservas,
worker y fotos integradas siguen fuera de este cambio. La habilitación vigente es
una fila de `memberships`, sin roles ni estados. La cabecera de actor temporal fue
retirada del runtime, incluso si se conserva una variable vieja en el entorno.

## Qué cruza las fronteras

| Port de Application | Adaptador | Datos que intercambia |
| --- | --- | --- |
| `EmailCanonicalizer` | `createEmailCanonicalizer`, PostgreSQL | Texto original → resultado de `canonicalize_email`. |
| `IdentityRepository` | `createIdentityRepository`, PostgreSQL | Usuario, credencial interna, establecimientos; creación conjunta y conflicto semántico. |
| `PasswordHasher` | `createPasswordHasher`, crypto de Node | Contraseña solo en memoria; hash/sal/parámetros o resultado de verificación. |
| `SessionCredentials` | `createSessionCredentials`, crypto de Node | Secreto aleatorio y huella; huella a partir del secreto. |
| `SessionRepository` | `createSessionRepository`, PostgreSQL | Solo huella para búsqueda/creación; hechos de expiración/revocación. |
| `LoginSecurityRepository` | `createLoginSecurityRepository`, PostgreSQL | Estado, eventos y writer limitado al alcance de una transacción por cuenta. |

[Ports](../api/src/application/identity/ports.ts),
[casos de uso](../api/src/application/identity/use-cases.ts),
[reglas puras](../api/src/domain/identity.ts),
[HTTP](../api/src/http/auth-router.ts) y [Composition](../api/src/composition.ts).
Los ports usan strings para bigint, Date y Uint8Array; no transportan Express,
clientes pg ni cookies. HTTP mantiene el vínculo de la request con su sesión
mediante un WeakMap; Application recibe la credencial opaca, no una cabecera Cookie.

Domain solo contiene políticas puras de formato, longitud y duraciones. Application
coordina registro, login, resolución y logout; también decide la ventana y el bloqueo.
Infrastructure ejecuta SQL/criptografía sin decidir permisos. HTTP extrae cookies,
valida Origin/CSRF, aplica límites de tráfico y traduce errores. CSRF tiene un contrato
local en HTTP implementado por el adaptador criptográfico, sin meter esa regla de
transporte en los casos de uso.

## Persistencia y atomicidad

La [migración](../api/migrations/1790000000001_identity-sessions.sql) conserva bigint
interno, añade UUID público a users y protege email canónico con CHECK y UNIQUE.
Antes de cambiar nada bloquea users y exige que esté vacío. Si encuentra una fila,
aborta con diagnóstico; no normaliza cuentas existentes, fusiona ni borra datos.
Un down conserva usuarios/memberships, pero pierde credenciales, sesiones, fallos y
UUID de usuario. No es restauración: reaplicar con usuarios conservados debe fallar.
Las pruebas de rollback histórico K010 fijan la versión que están verificando.

`user_credentials` separa identidad de capacidad de autenticar. Guarda sal de 16
bytes, hash scrypt de 64 y N/r/p explícitos. No se fabrican credenciales para cuentas
sin ellas. El registro confirma usuario y credencial en la misma transacción; si
falla la segunda inserción, no queda usuario huérfano. UNIQUE resuelve también dos
registros concurrentes con el mismo correo.

La canonicalización reside únicamente en PostgreSQL (`canonicalize_email`, ICU raíz,
trim explícito ECMAScript). Conserva puntos y +; no aplica reglas Gmail ni NFC/NFKC.
Application invoca ese port y valida después el formato `email` del contrato. La
normalización Unicode no implica admitir direcciones internacionalizadas fuera de
ese formato: por ejemplo, un acento se conserva al normalizar, pero puede invalidar
la dirección. Se prueban NBSP, BOM y diferencias relevantes de minúsculas Unicode.

`sessions` guarda SHA-256 de los 32 bytes aleatorios que forman el secreto. El
navegador recibe su codificación base64url (43 caracteres), solo en cookie. La base
nunca recibe el secreto reutilizable. La huella permite buscar la sesión y revisar
expiración/revocación; no permite presentar la cookie original. `expires_at` es
siempre `created_at + 12 horas`. Login genera otra credencial y revoca la sesión
presentada, si existe, en la misma transacción; otras sesiones permanecen vigentes.
Esto también admite cambiar de cuenta sin conservar activa la sesión reemplazada.
La rotación prueba posesión por huella; no acepta un ID de sesión del cliente.

### Intentos de login

1. Leer cuenta/estado. Si el bloqueo está vigente, responder 429 sin scrypt.
2. Verificar scrypt fuera de toda transacción/lock. Cuenta inexistente usa una
   credencial señuelo aleatoria solo en memoria y responde el mismo 401 genérico.
3. Inicializar/bloquear `login_security_state`, releer estado y tomar el instante
   actual después de esperar. `lock_timeout=2s`; conflicto de disponibilidad: 503.
4. Si entretanto se bloqueó, no crear sesión aunque la contraseña sea correcta.
5. Limpiar fallos con `failed_at <= now - 15 minutos`; contar en `(límite, now]`.
   Un éxito conserva los fallos recientes. Un fallo agrega un evento; el quinto
   fija `blocked_until=now+15 minutos`. Se confirma la transacción y luego se
   responde 401: lanzar el error antes de COMMIT perdería el fallo registrado.
6. Durante el bloqueo no se agregan fallos, no se extiende el plazo ni se revocan
   sesiones existentes. Al vencer, el siguiente intento vuelve a evaluar/limpiar.

El estado sobrevive reinicios y funciona entre procesos que comparten PostgreSQL.
La limpieza es por cuenta al siguiente intento permitido; una cuenta inactiva puede
conservar hasta cinco eventos antiguos. No hay un historial ilimitado de auditoría
ni un job nuevo. Sesiones vencidas/revocadas se conservan; una política de retención
y mantenimiento de volumen deberá definirse con la operación, sin inventar borrado
automático en K008.

## Criptografía y protección HTTP

Una contraseña no se cifra para recuperarla: scrypt deriva una huella costosa y se
compara usando la sal y parámetros guardados. Dos usuarios con igual contraseña
tienen sales aleatorias diferentes y, por tanto, hashes diferentes. Crear credenciales
usa N=65536, r=8, p=2; verificar usa los parámetros de cada fila. Ese perfil y
N=131072/r=8/p=1 son los únicos admitidos. No hay defaults SQL de costo.

La medición local elegida tuvo mediana secuencial de 211.3 ms y pico RSS de 177 MiB
incluyendo dos cálculos simultáneos y runtime. Hay como máximo dos cálculos por
instancia compartida, sin cola ilimitada; saturación responde 503. Es evidencia del
entorno WSL2 medido, no garantía de capacidad/latencia de producción. Ver metodología
completa en la guía HTTP y repetir `npm --prefix api run crypto:benchmark` al cambiar
hardware o recursos. El perfil es una alternativa documentada por
[OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).

Ambas cookies usan `__Host-`, HttpOnly, Secure, SameSite=Lax, Path=/, sin Domain,
Max-Age=43200; logout usa Max-Age=0 y los mismos atributos. CSRF emplea nonce,
expiración y HMAC-SHA256 con clave de configuración, firmado sobre el contexto
anónimo o ID interno de sesión. No contiene el secreto de autenticación. Se exige
igualdad header/cookie más firma, plazo y vínculo válidos. GET reutiliza un token
válido; login rota el contexto y el token previo no sirve para la nueva sesión.
Es el patrón de [double-submit firmado](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#signed-double-submit-cookie-recommended).

Origin debe coincidir exactamente con un origen HTTPS configurado; ausente, null,
ajeno o con barra extra falla. No se usa Referer ni CORS abierto. Todas las respuestas
API son no-store; errores y logs no incluyen contraseña, cookie, tokens ni mensajes
SQL. El único dato técnico registrado al fallar es categoría/código controlado.

Los límites generales son token bucket: 120/minuto/usuario con ráfaga 20 y
3000/minuto/IP con ráfaga 100. Login añade ventana móvil de 30 intentos/IP/15 minutos.
Estos límites de tráfico son **por proceso**, con limpieza y mapas acotados; se
reinician al reiniciar la API. El bloqueo de cuenta, en cambio, siempre persiste en
PostgreSQL. Varios procesos multiplican límites de tráfico; deben complementarse
con límites compartidos en el ingreso si se escala. No se confía en X-Forwarded-For:
un proxy agrega clientes bajo su IP, de manera conservadora. La topología/proxies
de confianza del despliegue debe fijarse antes de cambiar esa política.

## Configuración y HTTPS local

`DATABASE_URL`: base ya migrada. `RESCATE_ALLOWED_ORIGINS`: orígenes HTTPS exactos,
separados por coma. `CSRF_SIGNING_KEY`: al menos 32 bytes aleatorios en base64
canónico; sin default en la API, compartida entre instancias y conservada entre
reinicios. Generar con `openssl rand -base64 32`, guardar fuera de Git en api/.env.
Rotarla invalida CSRF existente, pero no elimina sesiones: obtener otro token con GET.

Compose sigue siendo desarrollo/smoke HTTP en loopback. Su clave de ejemplo es
pública, no segura para uso real; la API la rechaza con NODE_ENV=production. Las
cookies no pierden Secure para facilitar desarrollo. Para HTTPS directo:

```sh
# Archivos efímeros fuera del repositorio; OpenSSL instalado en el host.
mkdir -p /tmp/rescate-local-tls
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /tmp/rescate-local-tls/key.pem -out /tmp/rescate-local-tls/cert.pem \
  -days 7 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
# Antes: configurar api/.env, incluida una clave propia y DATABASE_URL.
# Aplicar migraciones solo sobre una base cuyo estado se haya revisado.
cd api
npm run build
PORT=3443 TLS_CERT_FILE=/tmp/rescate-local-tls/cert.pem \
  TLS_KEY_FILE=/tmp/rescate-local-tls/key.pem \
  node --env-file=.env dist/index.js
```

Configurar `RESCATE_ALLOWED_ORIGINS=https://localhost:3443`. Verificar con
`curl --cacert /tmp/rescate-local-tls/cert.pem https://localhost:3443/auth/session`.
En navegador hay que confiar explícitamente en el certificado local o usar un
certificado de desarrollo confiable. En producción, TLS puede terminar en un proxy
HTTPS del mismo origen, con HTTP interno protegido. No se configura ese despliegue
público ni se afirma que el Compose HTTP ya entregue una web autenticada.

El flujo de consumo es GET session → guardar csrfToken en memoria → enviar cookies,
Origin y X-CSRF-Token al comando. Login devuelve otro csrfToken; reemplazar el anterior.
No guardar tokens en localStorage ni reenviar escrituras automáticamente ante 403.

## Evidencia reproducible

Desde la raíz, con dependencias instaladas:

```sh
npm --prefix api run typecheck
npm --prefix api test
npm --prefix api run build
npm --prefix api run api:types:check
npm --prefix api run api:contract:check
docker compose --env-file .env.example up -d db
npm --prefix api run db:test:compose
npm --prefix api run db:test:lots:compose
npm --prefix api run db:test:identity:compose
cd api
npx playwright install chromium
# Linux nuevo: npx playwright install --with-deps chromium
npm run db:test:auth:compose
```

Los wrappers crean bases `rescate_k008_test_*` desde template0 y las conservan.
No migran ni borran la base de desarrollo. La prueba funcional usa certificado
OpenSSL efímero, un proceso API hijo y Chromium; limpia procesos y archivos temporales.
El certificado ignorado por Chromium es solo el de esa prueba aislada.

| Evidencia | Garantía |
| --- | --- |
| [Crypto](../api/test/identity-crypto.test.ts) | Sal aleatoria, verificación por parámetros persistidos, límites de costo/capacidad, secreto/huella canónicos. |
| [Application](../api/test/identity-application.test.ts) | Ventana móvil, quinto fallo, éxito conserva eventos, bloqueo posterior a scrypt, expiración y errores de persistencia. |
| [Seguridad](../api/test/auth-security.test.ts) | Firma CSRF, expiración/vínculo/clave, límites de tráfico y configuración cerrada. |
| [Infrastructure PostgreSQL](../api/scripts/test-identity.mjs) | Atomicidad, rollback, duplicado concurrente, lock/relectura y persistencia de hechos. |
| [Funcional PostgreSQL/HTTPS](../api/scripts/test-auth.mjs) | Nueve grupos: contrato auth, sesión tras reinicio real, permisos K010 actuales, rotación/logout, bloqueo persistente, expiración, concurrencia de cinco fallos, navegador HTTPS e indisponibilidad/recuperación de PostgreSQL. |
| [Migración](../api/scripts/test-identity-schema.mjs) | Precondición segura de users vacío, constraints, Unicode; historial y down mediante test-migrations. |

La prueba de concurrencia funcional usa un verificador controlado para fijar el
orden de llegada; locks/SQL/transacciones son reales. El resto del recorrido y el
navegador usan scrypt real. La prueba HTTPS usa una página mínima de fixture: no
acredita formularios React K009/K011 ni toda E2. CI incluye los comandos anteriores,
pero no se ha ejecutado GitHub Actions remoto ni se ha desplegado este cambio.

## Resultado de la validación final local

Ejecutado el 2026-09-21 con Node 24.14.0 y PostgreSQL 16.9:

- API: 36 tests aprobados; typecheck, build, DTO sincronizados y Redocly aprobados.
- Historial/migraciones: 132 comprobaciones; K010 PostgreSQL: 29 comprobaciones.
- Infrastructure K008: 7 grupos; recorrido funcional K008/K010: 9 grupos.
- Chromium HTTPS: cookies reales, cuenta ajena rechazada y logout comprobados.
- Reinicio real de API, carrera de login y caída/recuperación controlada de la base
  dedicada comprobados; respuesta 503 sin convertir una falla SQL en visitante.
- Web: typecheck, lint y build aprobados; no se añadieron pantallas de negocio.
- Compose: imágenes API/worker construidas, servicios saludables, /health directo
  y vía proxy, web y worker inactivo comprobados. Sin migrar la base de desarrollo.
- YAML CI/Compose, enlaces locales, Mermaid revisado y diff sin errores de espacios.

Última base funcional conservada: `rescate_k008_test_1790022992075_0b11ed2c`.
Los resultados son locales, sobre datos ficticios; no representan CI remoto,
certificación de producción ni aceptación de las pantallas pendientes.

## Recorrido para estudiar

Ana registra `Ana@Example.com`: HTTP valida estructura, Application pide el correo
canónico a PostgreSQL y comprueba reglas; crypto produce sal/hash; el repositorio
confirma usuario + credencial. Aún no tiene sesión ni permisos operativos.

Más tarde envía su contraseña al login. Application consulta la credencial y verifica
scrypt fuera del lock. Bajo lock relee protección, persiste la huella de una nueva
sesión y confirma. HTTP entrega el secreto exclusivamente en cookie HttpOnly y un
nuevo token CSRF. La cookie regresa en otra request: HTTP extrae el secreto,
Application calcula su huella vía port y consulta la sesión vigente; obtiene el
usuario interno y HTTP construye Actor. Si Ana modifica un lote, K010 comprueba la
membership del establecimiento. Estar autenticada identifica a Ana; no le concede
permisos sobre todos los lotes.

Para revisar el diseño, conviene distinguir: UUID público frente a bigint interno;
hash de contraseña costoso frente a huella rápida de un secreto aleatorio;
autenticación por sesión frente a autorización por membership; y transacción corta
que decide/confirma frente al cálculo costoso que ocurre antes. Ninguna cookie ni
lista de establecimientos sustituye una comprobación de permiso en Application.
