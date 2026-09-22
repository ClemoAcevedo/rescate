# Frontend

React 19 + React Router 7, TypeScript 6 y Vite 8. CSS plano; versiones instalables
en [package.json](package.json) y [package-lock.json](package-lock.json).

## Empezar

Desde `web/`: `npm ci`, `npm run dev`. Para conectar la comprobación técnica con
la API local, configurar `VITE_API_BASE_URL=/api`; el proxy usa
`API_PROXY_TARGET` o `http://localhost:3000`. Ver [entorno local](../docs/desarrollo-local.md).
Checks: `npm run typecheck`, `npm run lint`, `npm run build`.
No hay suite ni dependencias de tests dentro de `web/`: la comprobación end-to-end
de autenticación usa el Playwright ya instalado en `api/`, contra servicios reales
que la persona inicia explícitamente (`npm --prefix api run test:web:auth`).

## Mapa del código

| Ubicación | Responsabilidad |
| --- | --- |
| [app/App.tsx](src/app/App.tsx) | Rutas y redirección raíz, preservando query string |
| [app/global.css](src/app/global.css) | Reset, tipografía global y layout adaptable |
| [styles/tokens.css](src/styles/tokens.css) y [styles/ui.css](src/styles/ui.css) | Tokens y apariencia compartida |
| [components/ui](src/components/ui/README.md) | Primitives reutilizables, ejemplos y accesibilidad |
| `components/AppLayout`, `SiteHeader`, `RescateLogo` | Shell, navegación y marca de la aplicación |
| `pages/` | Pantallas; decisiones y composición de producto |
| [services](src/services/README.md) | Cliente HTTP y límites del contrato |
| `types/api.ts`, `services/api-types.ts` | Antecedentes K004; no contrato S02 |

## Estado de las rutas

`/` redirige a `/lotes`. `/lotes` y `/lotes/:id` son demostraciones estáticas;
`/registro` y `/login` integran K008. `/conexion` consulta únicamente
`/health`; las rutas desconocidas muestran la pantalla 404. Recargas directas
requieren fallback SPA del servidor en producción.

La base visual y K009 están implementadas; la publicación K011 sigue pendiente.
K011 debe reutilizar UI y derivar sus tipos desde [OpenAPI S02](../docs/api/README.md),
sin convertir demos externas en reglas de negocio. La selección del material y
la evidencia local están en [integración del design system](../docs/frontend-design-system.md).

## Identidad K008 (K009)

La web consulta `GET /auth/session` al cargar, conserva el `csrfToken` solo en
memoria y envía `X-CSRF-Token` en los comandos. `fetch` usa `credentials: include`:
la cookie opaca no se lee ni se guarda en la aplicación. Registro no inicia sesión;
login actualiza la sesión y rota CSRF; logout mantiene el estado si el servidor no
confirma el cierre. Errores de credenciales, validación, red, permisos y respuestas
inesperadas se presentan por separado.

El modo controlado se habilita únicamente en desarrollo con
`VITE_AUTH_MOCK_SCENARIO` (`success`, `validation`, `credentials`, `network`,
`forbidden` o `logout-failure`) y opcionalmente `VITE_AUTH_MOCK_DELAY_MS`. Nunca
se activa como reserva cuando falla la API real y Vite no expone estas variables en
una compilación de producción.

Si no existe `web/.env`, la web usa igualmente `/api` como base predeterminada.
Así la consulta inicial llega al proxy de Vite y no al fallback HTML de la SPA.

K008 requiere cookies `Secure` y un `Origin` HTTPS exacto. La API no expone CORS
para consumo cruzado: usa la misma origin mediante el proxy `/api` de Vite o del
servidor de producción. Para desarrollo HTTPS, genera un certificado efímero como
indica [K008](../docs/k008-identidad.md), inicia la API con
`RESCATE_ALLOWED_ORIGINS=https://localhost:5173`, y ejecuta:

```bash
cd web
DEV_TLS_CERT_FILE=/tmp/rescate-local-tls/cert.pem \
DEV_TLS_KEY_FILE=/tmp/rescate-local-tls/key.pem \
API_PROXY_TARGET=http://localhost:3000 npm run dev
```

Abre `https://localhost:5173` tras confiar explícitamente en el certificado. No
usar HTTP para acreditar sesión real: el navegador descartará las cookies Secure.
