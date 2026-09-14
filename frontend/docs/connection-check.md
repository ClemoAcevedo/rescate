# Comprobación técnica de conexión

La ruta `/conexion` consulta `GET /health` mediante el cliente HTTP de la web.
No está enlazada desde la navegación principal y no participa en las funciones
de identidad ni lotes.

## Endpoint utilizado

| Propiedad | Evidencia confirmada |
| --- | --- |
| Método y ruta | `GET /health` |
| Autenticación | No requerida en su implementación actual |
| Respuesta válida | `{ "status": "ok" }` con JSON |

La evidencia proviene de `api/src/index.ts` en la rama de preparación
`chore/initial-repository-setup`. La rama actual no contiene ese servicio ni
una URL de backend desplegada.

## Estados de la vista

- Inicial: permite iniciar la consulta.
- Carga: deshabilita el botón para evitar consultas duplicadas.
- Correcto: se muestra solo cuando la respuesta valida exactamente el estado
  `ok`.
- Error: muestra un mensaje seguro y ofrece reintento; no presenta cuerpo de
  respuesta, URL, credenciales ni detalles internos.

## Información pendiente para una comprobación real en navegador

Para usar el caso exitoso fuera de desarrollo hace falta confirmar:

1. La URL del backend desplegado para `VITE_API_BASE_URL`.
2. La política CORS o un proxy de mismo origen si frontend y backend usan
   orígenes distintos.
3. La disponibilidad de `GET /health` en el despliegue de backend.

La implementación de API revisada no configura CORS. Por ello, apuntar Vite
directamente a `http://localhost:3000` permite verificar el endpoint con un
cliente HTTP local, pero no certifica una llamada exitosa desde el navegador.

## Comprobación local

Para verificar el caso exitoso en `/conexion`, configura un backend de mismo
origen o uno que autorice explícitamente el origen de Vite, y asigna su URL a
`VITE_API_BASE_URL` antes de ejecutar `npm run dev`.

Para provocar un fallo controlado sin modificar servicios compartidos, inicia
Vite temporalmente con una URL local sin servicio:

```bash
VITE_API_BASE_URL=http://127.0.0.1:65534 npm run dev
```

Abre `/conexion`, selecciona **Consultar conexión** y confirma el mensaje de
error y la acción **Reintentar conexión**. No guardes esa URL de prueba en
archivos de entorno compartidos.
