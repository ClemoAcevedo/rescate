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

## Evidencia de esta ejecución

| Criterio | Estado | Evidencia |
| --- | --- | --- |
| Tipos, lint y build web | Cumplido | `npm run typecheck`, `npm run lint`, `npm run build` aprobados el 2026-09-22. |
| Flujos controlados y carga | Implementado; verificación manual pendiente | El escenario se selecciona por `VITE_AUTH_MOCK_SCENARIO` y demora configurable. Vite inició en `127.0.0.1:4177`; no había Chromium/Playwright instalado para automatizar la inspección. |
| Registro, login, recarga, logout con K008 real | Pendiente | No había API local en `localhost:3000` y Docker no está instalado en este entorno. |
| Error de red y permiso con API real | Pendiente | Requiere API HTTPS, base migrada y cuenta de prueba autorizada. |
| Recorridos visuales a 360 y 1366 px | Pendiente | No se declara acreditado: el entorno no disponía de navegador automatizable. |

La falta de API/navegador no se sustituye por la simulación. Antes de aceptar K009,
seguir los recorridos de integración y viewport indicados en la tarjeta con datos
de prueba autorizados.
