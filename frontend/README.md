# Frontend de Rescate

Aplicación web construida con React, TypeScript, Vite y React Router.

## Comandos

Desde esta carpeta:

```bash
npm install
npm run dev
npm run lint
npm run build
```

`npm run dev` inicia el servidor de desarrollo y muestra la URL local en la
terminal. `npm run build` realiza la comprobación de tipos y crea la versión de
producción en `dist/`.

## Rutas

- `/` redirige a `/lotes`.
- `/lotes` muestra el listado provisional.
- `/lotes/:id` muestra el detalle provisional de un lote.
- `/registro` y `/login` muestran sus pantallas provisionales.
- `/conexion` ofrece una comprobación técnica separada de la navegación principal.
- Cualquier otra dirección muestra una página 404.

## API

La propuesta de contrato de identidad y lotes está en
[docs/api-contract.md](docs/api-contract.md). Configura la URL base mediante
`VITE_API_BASE_URL`; consulta `.env.example`. La prueba técnica de salud y sus
límites de despliegue están documentados en
[docs/connection-check.md](docs/connection-check.md).

## Despliegue

La aplicación usa rutas del lado del cliente mediante `BrowserRouter`. El
alojamiento debe responder con `index.html` para solicitudes a rutas internas
que no correspondan a archivos estáticos (por ejemplo, `/lotes/demo`) para que
React Router pueda resolverlas después de una recarga o acceso directo.
