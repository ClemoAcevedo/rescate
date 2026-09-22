# K009 — Registro y sesión en la web

Fecha de implementación: 2026-09-22. K008 y [OpenAPI](api/openapi.yaml) son la
fuente de verdad: `GET /auth/session` entrega estado y CSRF; registro no inicia
sesión; login rota sesión/CSRF y logout debe confirmar `204` antes de limpiar estado.

## Corrección posterior: bootstrap de sesión

El 2026-09-22 se confirmó que, sin `web/.env`, el cliente construía
`GET /auth/session` en vez de `GET /api/auth/session`. Vite devolvía entonces el
HTML del fallback SPA con estado 200 y el parser de `SessionResponse` lo rechazaba.
No era una sesión ausente: K008 representa esa condición como JSON con
`session: null` y `csrfToken`. El cliente ahora usa `/api` como valor base por
defecto y comprueba `Content-Type: application/json` para respuestas parseadas.
El aviso de fallo de sesión se mueve fuera de la navegación y permite reintentar.

## Implementado

- Formularios accesibles de registro y acceso en `/registro` y `/login`, con
  correo, contraseña de mínimo 12 caracteres, autocompletado, validación nativa,
  errores por campo del contrato y foco nativo en el primer control inválido.
- Cliente de identidad con parser de respuesta, cookies `include`, CSRF en memoria
  y clasificación de validación, credenciales, red, permiso/CSRF, límite,
  indisponibilidad y respuesta inesperada.
- Estado explícito de comprobación, sesión activa, visitante, fallo de consulta y
  cierre en curso. Lecturas tardías se abortan o descartan por generación para que
  no restauren una sesión después de login/logout.
- Cabecera adaptada a sesión y cierre que conserva la sesión local si el servidor
  no confirma el cierre.
- Respuestas controladas limitadas a desarrollo y claramente configurables; no
  contienen ni registran contraseñas, cookies o tokens.

## Configuración e integración real

La web consume la base `VITE_API_BASE_URL=/api` y el proxy elimina `/api`. K008
exige `Secure`, por lo que la integración real requiere HTTPS en la origin de la
web y `RESCATE_ALLOWED_ORIGINS=https://localhost:5173`. Se habilita HTTPS local
con `DEV_TLS_CERT_FILE` y `DEV_TLS_KEY_FILE`, documentado en [web/README](../web/README.md).
No se usa CORS con credenciales ni se lee la cookie HttpOnly.

## Diagnóstico e integración real (2026-09-22)

Al inicio no había listeners en 3000, 5173 ni 5432, `.env` estaba ausente y Docker
no estaba instalado. Por eso el Vite HTTP de 5173 no podía reenviar `/auth/session`
a `127.0.0.1:3000` y mostraba `ECONNREFUSED`. Es una dependencia de entorno, no una
sesión ausente. Además, sin una base explícita el cliente pedía `/auth/session`, que
Vite resolvía mediante el fallback SPA (HTML 200); el cambio de base predeterminada
a `/api` evita esa respuesta falsa.

Para aislar la comprobación se levantaron PostgreSQL 16.10 temporal en el puerto
55432, una API con migraciones en 3001 y Vite HTTPS en 5174. La origin exacta
permitida fue `https://localhost:5174`; Vite reenvió `/api` a la API HTTP local.
No se usó una base de desarrollo, ni se mostraron contraseñas, cookies o tokens.

| Solicitud del navegador (URL efectiva) | Estado y Content-Type | Estructura comprobada |
| --- | --- | --- |
| `GET https://localhost:5174/api/auth/session` sin sesión | 200, `application/json` | `session`, `csrfToken`; `session: null` |
| `GET https://localhost:5174/api/health` | 200, `application/json` | `status` |
| `POST https://localhost:5174/api/auth/register` | 201, `application/json` | `user`; la recarga posterior mantuvo `session: null` |
| `POST https://localhost:5174/api/auth/login` con clave incorrecta | 401, `application/json` | `error.code: UNAUTHENTICATED` |
| `POST https://localhost:5174/api/auth/login` válida | 200, `application/json` | `session`, `csrfToken` |
| `POST https://localhost:5174/api/auth/register` con CSRF inválido | 403, `application/json` | `error.code: FORBIDDEN` |
| `POST https://localhost:5174/api/auth/logout` | 204, sin cuerpo | Sin JSON; la UI solo limpió estado tras esa confirmación |

Esto coincide con OpenAPI: visitante no es error (200 con `session: null`),
credenciales incorrectas son 401 `UNAUTHENTICATED`, y CSRF/origin/permisos son 403
`FORBIDDEN`. El flujo funcional K008 adicional comprobó con PostgreSQL real que una
membresía ausente o retirada devuelve 403 al operar/consultar un lote y que una
dependencia caída devuelve 503 `SERVICE_UNAVAILABLE`; K009 no tiene aún una pantalla
de lotes que emita esa solicitud.

## Verificación de K009

| Criterio | Resultado | Evidencia |
| --- | --- | --- |
| Base, proxy y bootstrap CSRF | Cumplido | `http-client.ts` usa `/api` por defecto; la prueba real comprobó sesión anónima JSON, cookie HttpOnly/Secure y CSRF en memoria. |
| Registro sin sesión automática | Cumplido | Playwright: 201, mensaje de éxito y recarga con `session: null`. |
| Login, recarga y logout reales | Cumplido | Playwright: 200, sesión recuperada tras recargar y logout 204 antes de limpiar UI. |
| Credenciales, CSRF/permisos, red y servidor | Cumplido según ámbito | 401 y 403 reales; `db:test:auth` comprobó membership 403 y 503. Escenarios controlados de validación, credenciales, rechazo y red comprobaron los mensajes y tonos de la UI. |
| Feedback semántico | Cumplido | Un error global de registro (409/403/red incluido) siempre usa `Alert` danger con `role=alert`; el éxito usa `role=status`. |
| Layout 360×800 y 1366×768 | Cumplido | Chromium a 100 % verificó `scrollWidth <= innerWidth`, scroll normal y foco de correo, contraseña, envío y enlace. Capturas temporales revisadas en ambos viewports. No hubo acceso al tamaño real de la ventana de la persona. |
| Checks | Cumplido | Web: typecheck, lint y build. API: typecheck, tests, build, OpenAPI y DTO; `test:web:auth` y `db:test:auth` con PostgreSQL temporal. |

La prueba reproducible de UI real es
[`api/scripts/test-web-auth.mjs`](../api/scripts/test-web-auth.mjs): requiere Vite
HTTPS, API y una base de prueba ya iniciados, y se ejecuta con
`WEB_URL=https://localhost:5174 npm --prefix api run test:web:auth`. Chromium se
ejecuta con certificado local aceptado solo para esta prueba. No acredita CI remoto
ni despliegue de producción.
