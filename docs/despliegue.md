# Despliegue

La web compilada vive en Vercel; API, worker y PostgreSQL/PostGIS, en Railway.
El navegador consulta `/api` bajo el dominio de la web. [vercel.mjs](../web/vercel.mjs)
reenvía esas rutas al origen HTTPS de Railway quitando el prefijo; las demás
rutas usan el fallback de React. Las respuestas de identidad conservan cookies
`__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, sin `Domain`, y `Cache-Control: no-store`.

`API_PROXY_TARGET` es el origen público exacto de Railway y
`VITE_API_BASE_URL=/api`. `RESCATE_ALLOWED_ORIGINS` en la API contiene el origen
exacto de producción de Vercel. Una URL de preview requiere su propio origen
permitido y una base aislada para comandos. No habilitar CORS con credenciales
ni usar mocks de identidad en el despliegue.

## Servicios

| Servicio | Configuración |
| --- | --- |
| PostgreSQL | Imagen `postgis/postgis:16-3.5`; volumen en `/var/lib/postgresql/data`; `PGDATA=/var/lib/postgresql/data/pgdata`; usuario, base y contraseña propia en variables Railway. Sin dominio público ni TCP proxy. |
| API | Contexto de build `api/`, [Dockerfile](../api/Dockerfile), `node dist/index.js`, `PORT=3000`, healthcheck `/health`, restart `ON_FAILURE`. Pre-deploy: `npm run db:migrate`. |
| Worker | Mismo contexto e imagen, `node dist/worker.js`, restart `ON_FAILURE`. Sin pre-deploy ni dominio público. Valida fotos y limpia objetos; necesita `DATABASE_URL` y el almacenamiento de fotos. Sin ellos queda inactivo. |
| Web | Proyecto Vercel vinculado a `web/`, Node 24.x, Vite, `npm ci` y build configurado en `vercel.mjs`; salida `dist/`. |

Railway conserva la configuración de los servicios. Al crear un entorno, fijar
estos valores antes del primer upload. Los uploads de Actions usan
`railway up api --path-as-root`, por lo que el Dockerfile queda en la raíz del
archivo enviado; el servicio no debe agregar otro prefijo `/api` al contexto.

La API recibe `NODE_ENV=production`, una `CSRF_SIGNING_KEY` generada con
`openssl rand -base64 32` y la referencia privada:

```text
DATABASE_URL=postgresql://${{postgres.POSTGRES_USER}}:${{postgres.POSTGRES_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{postgres.POSTGRES_DB}}
```

API y worker reciben además `NODE_ENV=production`, ese mismo `DATABASE_URL`,
`PHOTO_STORAGE=s3` y las cinco variables `PHOTO_S3_*` del bucket B2 privado
([fotos](fotos.md#configuración)). Sin `PHOTO_STORAGE`, cargar fotos responde 503,
el worker queda inactivo y el resto del sitio funciona.

Conservar la clave CSRF al reiniciar. Los secretos quedan en Railway, nunca en
variables `VITE_`. API y worker no están conectados al autodeploy de GitHub en
Railway; el proyecto Vercel tampoco tiene un autodeploy Git independiente.

## CI y producción automática

Los cambios entran por PR a `development`. El PR de release sale de `development`
hacia `main`; el check `Main / integration from development` valida ese origen.
Usar **Create a merge commit** al integrar releases y sincronizaciones entre
estas ramas: conserva la ascendencia común para los siguientes PR. En GitHub,
abrir el menú junto al botón de merge y seleccionar esa opción; el método usado
en otro PR puede quedar como predeterminado. Una sincronización `main` →
`development` también debe conservar el commit de merge.
Configurar protección de ambas ramas con revisión de otro integrante y CI
obligatorio. El [CI](../.github/workflows/ci.yml) valida web/API antes de probar
Compose, migraciones desde base vacía, upgrade, idempotencia y recorridos HTTPS.

El [workflow de producción](../.github/workflows/deploy.yml) se ejecuta al concluir
correctamente el CI de un push a `main` del mismo repositorio. Usa el SHA de esa
ejecución, sin volver a resolver la punta de la rama. Serializa las versiones
sin cancelar un despliegue a medio ejecutar:

1. Sube API. Railway ejecuta las migraciones una sola vez como pre-deploy, antes
   del arranque. Un error impide activar la nueva API y detiene la secuencia.
2. Espera `SUCCESS` del ID devuelto por ese upload, incluyendo healthcheck.
3. Sube el worker y espera su propio ID.
4. Construye y publica web en Vercel con el mismo SHA y un `release.json` público.
   La CLI devuelve JSON plano en CI y envuelto en modo no interactivo; se admiten
   ambas respuestas y se exige `READY` y una URL HTTPS antes de continuar.
5. Chromium comprueba SHA en el dominio estable, rutas SPA, botón de conexión,
   PostGIS, cookies, login, sesión persistida y logout.
6. Crea `deploy-<SHA>` y un release con commit, IDs de Railway, URL de Vercel y
   enlaces de CI/CD. Reejecutar el mismo commit actualiza ese release.

El environment GitHub `production` admite solo `main`. Contiene:

| Tipo | Nombres |
| --- | --- |
| Secrets | `RAILWAY_TOKEN`, `VERCEL_TOKEN`, `DEPLOY_SMOKE_EMAIL`, `DEPLOY_SMOKE_PASSWORD` |
| Variables | `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_API_SERVICE_ID`, `RAILWAY_WORKER_SERVICE_ID`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `API_PROXY_TARGET`, `WEB_URL` |

El secret GitHub `RAILWAY_TOKEN` guarda el token creado en **Account Settings →
Tokens** de Railway. El workflow lo expone a la CLI como `RAILWAY_API_TOKEN`,
porque corresponde a cuenta/workspace. No establecer simultáneamente
`RAILWAY_TOKEN` como variable de entorno de la CLI: ese nombre corresponde a
un token de proyecto y utiliza otro método de autenticación. El nombre del
secret GitHub se conserva; no hay que volver a copiar el token.

Crear `VERCEL_TOKEN` con alcance al equipo propietario del proyecto Vercel.
Renovar el token de Vercel antes de su expiración en la configuración de secrets.
La cuenta de smoke se registra una vez por HTTP, con contraseña aleatoria y sin
memberships. El pipeline usa esa cuenta y revoca su sesión al terminar; no crea
cuentas ni lotes en cada release. La semilla K012 se mantiene exclusivamente local.

## Comprobación y recuperación

Con las credenciales de smoke en el entorno, desde la raíz:

```bash
npm --prefix api ci
cd api && npx playwright install chromium && cd ..
WEB_URL=https://rescate-rescate1.vercel.app npm --prefix api run test:deploy
```

Sin credenciales se comprueban solo conexión, PostGIS y sesión anónima. Con
`DEPLOY_SHA` se exige además que el dominio sirva ese commit. `/health` verifica
el proceso HTTP; la búsqueda pública consulta PostgreSQL/PostGIS.

Las migraciones usan historial y advisory lock de node-pg-migrate. No se ejecutan
al arrancar Express ni desde el worker. [La prueba de migraciones](migraciones.md)
verifica upgrade sobre datos anteriores y rechazo de K008 si existen usuarios sin
credenciales; nunca borrar cuentas para superar esa precondición.

Los despliegues de servicios son secuenciales, sin transacción entre proveedores.
Si falla worker, web o smoke, la API puede haber cambiado: revisar el job y
reejecutar CD desde Actions después de corregir la causa. Para volver atrás,
revertir el cambio por PR y desplegar con CI. Conservar la base y el historial;
no ejecutar `db:rollback` en producción como parte de un rollback de aplicación.
Un cambio de esquema debe ser compatible con la API anterior mientras Railway
mantiene ambas versiones durante la transición.

Referencias: [pre-deploy de Railway](https://docs.railway.com/deployments/pre-deploy-command)
y [configuración programática de Vercel](https://vercel.com/docs/project-configuration/vercel-ts).
