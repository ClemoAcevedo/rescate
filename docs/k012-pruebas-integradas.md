# K012 — Datos semilla y pruebas de identidad/publicación

## Cargar datos locales

Usa PostgreSQL de [Compose](desarrollo-local.md) y configura `DATABASE_URL` en
`api/.env` con la conexión del host. La semilla acepta bases locales `rescate` o
`rescate_*`, requiere las migraciones y rechaza `NODE_ENV=production`.

Desde la raíz, con las dependencias de la API instaladas:

```bash
npm --prefix api run db:migrate
npm --prefix api run db:seed:demo
```

La carga crea tres cuentas, dos establecimientos y cuatro lotes. Usa una
transacción y el adaptador scrypt de la API. Si falla, revierte sus escrituras.
Al repetirla, verifica las cuentas y permisos existentes y añade lotes faltantes.
Conserva contraseñas, sesiones y ediciones; aborta si los datos de las cuentas o
sus permisos fueron modificados.

| Cuenta | Establecimiento | Lotes |
| --- | --- | --- |
| `operador.norte@example.test` | Almacén Norte ficticio | Un borrador y uno publicado |
| `operador.sur@example.test` | Almacén Sur ficticio | Un borrador y uno publicado |
| `visitante@example.test` | Ninguno | Sin acceso a lotes |

Contraseña pública de prueba: `Rescate-K012-solo-pruebas!`.
Los IDs están en [demo-data.mjs](../api/fixtures/demo-data.mjs).

Los lotes nuevos tienen retiro desde una hora hasta siete días después de la
carga. Para renovar las ventanas de los cuatro lotes ficticios que ya terminaron:

```bash
npm --prefix api run db:seed:demo -- --refresh-expired-lots
```

Esta opción cambia únicamente inicio/fin de retiro, versión y fecha de edición
de esos fixtures vencidos, incluidos los publicados. Conserva contenido y estado.
Es una operación local de preparación de datos; las reglas de edición de la API
siguen vigentes. Sin la opción, las fechas existentes se conservan.

## Usar la web

Inicia la API y Vite con la [configuración HTTPS existente](../web/README.md).
La API debe usar la misma `DATABASE_URL` donde cargaste los datos. Mantén
`VITE_AUTH_MOCK_SCENARIO` desactivado y entra con una cuenta de la tabla.

El formulario K011 está pendiente y el listado web contiene demostraciones.
Los lotes persistidos se consultan mediante `GET /api/lots/{id}` con sesión de
su operador; la [API K010](k010-publicacion-lotes.md) permite crear y publicar.

## Comprobar desde una base vacía

Con el servicio `db` de Compose iniciado, Node.js, OpenSSL y Chromium instalados:

```bash
cd api
npx playwright install chromium
npm run db:test:auth:compose
```

El comando existente crea una base aislada `rescate_k008_test_*`, aplica las
migraciones y ejecuta [test-auth.mjs](../api/scripts/test-auth.mjs). Conserva la
base para inspección y cierra el servidor HTTPS y Chromium al terminar.
`COMPOSE_PROJECT_NAME` y `POSTGRES_PORT` deben coincidir con el Compose en uso.

Además de las pruebas de autenticación K008/K010, comprueba:

- Carga inicial, rollback, repetición y reposición de lotes sin perder ediciones.
- Login de las tres cuentas y publicación por ambos operadores mediante HTTPS.
- Rechazo de acceso entre establecimientos y del visitante en las cuatro operaciones.
- Conservación de permisos revocados y ausencia de escrituras tras los rechazos.
- Renovación explícita de fixtures vencidos sin modificar otros lotes ni sesiones.

Las respuestas HTTP se validan contra OpenAPI. Chromium comprueba las cookies
reales; el recorrido visual de registro/login/logout se ejecuta contra API y Vite
con `WEB_URL=https://localhost:5173 npm --prefix api run test:web:auth`.
