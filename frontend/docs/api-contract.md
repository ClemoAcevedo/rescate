# Contrato de API propuesto: identidad y lotes

**Estado: pendiente de validación con backend.** Este documento prepara el
consumo desde la web; no constituye un contrato definitivo ni implementa una
integración funcional.

## Evidencia revisada

En la rama actual no hay API, esquemas ni documentación de endpoints. En la
rama de preparación del repositorio solo se identificó `GET /health`, que
responde `{ "status": "ok" }`; no define operaciones de identidad ni lotes.
Por ello, todas las operaciones de este documento son propuestas.

## Convenciones propuestas

- Prefijo propuesto: `/api`.
- Cuerpos de solicitud y respuesta: JSON, salvo una respuesta vacía explícita.
- Los identificadores se tratan como cadenas para no asumir su formato.
- La autenticación no está decidida: este contrato no prescribe cookies, tokens,
  cabeceras `Authorization` ni almacenamiento de credenciales.

## Operaciones de identidad

### Registro — propuesto

| Propiedad | Propuesta |
| --- | --- |
| Método y ruta | `POST /api/auth/register` |
| Cuerpo | `{ "email": string, "password": string, "displayName"?: string }` |
| Éxito | `201 Created` con `{ "user": Identity }` |
| Errores relevantes | `400` datos inválidos, `409` correo ya registrado |

Falta confirmar requisitos de contraseña, normalización de correo, si el nombre
es obligatorio y si el registro inicia sesión automáticamente.

### Inicio de sesión — propuesto

| Propiedad | Propuesta |
| --- | --- |
| Método y ruta | `POST /api/auth/login` |
| Cuerpo | `{ "email": string, "password": string }` |
| Éxito | `200 OK` con `{ "user": Identity }` |
| Errores relevantes | `400` solicitud inválida, `401` credenciales inválidas |

La respuesta no incluye token por diseño: el mecanismo de transporte de la
sesión queda pendiente de backend y seguridad.

### Consulta de sesión — propuesto

| Propiedad | Propuesta |
| --- | --- |
| Método y ruta | `GET /api/auth/session` |
| Parámetros | Ninguno propuesto |
| Éxito | `200 OK` con `{ "user": Identity }` |
| Errores relevantes | `401` sin sesión válida |

Falta definir si una sesión ausente se expresa como `401`, `204` u otra
representación.

### Cierre de sesión — propuesto

| Propiedad | Propuesta |
| --- | --- |
| Método y ruta | `POST /api/auth/logout` |
| Cuerpo | Ninguno propuesto |
| Éxito | `204 No Content` |
| Errores relevantes | `401` si backend requiere una sesión válida |

El `204` permite una respuesta sin cuerpo; el cliente HTTP la admite de forma
explícita.

## Operaciones de lotes

### Listado de lotes — propuesto

| Propiedad | Propuesta |
| --- | --- |
| Método y ruta | `GET /api/lotes` |
| Parámetros | Ninguno confirmado |
| Éxito | `200 OK` con `{ "items": LotSummary[] }` |
| Errores relevantes | `500` error interno; otros estados por definir |

Están pendientes filtros, orden, búsqueda, disponibilidad, paginación, tamaño
máximo de página y si la respuesta incluye un total o cursor. La web no debe
asumirlos antes de la validación.

### Detalle de lote — propuesto

| Propiedad | Propuesta |
| --- | --- |
| Método y ruta | `GET /api/lotes/:id` |
| Parámetro de ruta | `id: string` |
| Éxito | `200 OK` con `LotDetail` |
| Errores relevantes | `404` lote inexistente, `500` error interno |

Falta confirmar visibilidad de lotes vencidos o reservados, autorización,
formato de fechas, unidad/cantidad, ubicación y el conjunto válido de estados.

## Tipos web propuestos

Los tipos están en `src/types/api.ts`:

- `Identity`, `RegisterInput` y `LoginInput` para identidad.
- `LotSummary` y `LotDetail` para lotes.

`status` se expresa como `string` intencionalmente: no hay un catálogo de
estados confirmado. Los campos opcionales de nombre, cantidad, fechas y
ubicación también deben validarse con backend antes de usar la API real.

## Cliente HTTP preparado

`src/services/httpClient.ts` lee `VITE_API_BASE_URL` y expone `request` con un
validador de respuesta requerido para JSON. Distingue:

- `HttpError`: el servidor respondió un estado HTTP no exitoso; conserva
  estado, cabeceras y cuerpo, aunque el cuerpo no sea JSON.
- `NetworkError`: `fetch` no pudo establecer la conexión.
- `UnexpectedResponseError`: no se pudo leer el cuerpo, faltó JSON esperado o
  el validador rechazó los datos.

Para una respuesta vacía se debe solicitar `response: 'none'`; no se interpreta
como una respuesta JSON inválida. Los tipos TypeScript describen la intención,
pero la validación en tiempo de ejecución debe proporcionarse al llamar al
cliente.

## Configuración local

Copia `.env.example` a `.env.local` y ajusta `VITE_API_BASE_URL` para el
entorno correspondiente. Las variables con prefijo `VITE_` se exponen al
navegador, por lo que no deben contener secretos.
