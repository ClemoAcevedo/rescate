# Frontend

React 19 + React Router 7, TypeScript 6 y Vite 8. CSS plano; versiones instalables
en [package.json](package.json) y [package-lock.json](package-lock.json).

## Empezar

Desde `web/`: `npm ci`, `npm run dev`. Para conectar la comprobación técnica con
la API local, configurar `VITE_API_BASE_URL=/api`; el proxy usa
`API_PROXY_TARGET` o `http://localhost:3000`. Ver [entorno local](../docs/desarrollo-local.md).
Checks: `npm run typecheck`, `npm run lint`, `npm run build`.
No hay suite de tests web ni herramienta de galería instalada.

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
`/registro` y `/login` anuncian formularios futuros. `/conexion` consulta únicamente
`/health`; las rutas desconocidas muestran la pantalla 404. Recargas directas
requieren fallback SPA del servidor en producción.

La base visual está implementada; autenticación y publicación siguen pendientes.
K009/K011 deben reutilizar UI y derivar sus tipos desde [OpenAPI S02](../docs/api/README.md),
sin convertir demos externas en reglas de negocio. La selección del material y
la evidencia local están en [integración del design system](../docs/frontend-design-system.md).
