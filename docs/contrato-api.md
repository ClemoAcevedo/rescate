# Contrato API propuesto: identidad y lotes

> Estado: **pendiente de validación con backend**. Este documento no define la API de forma definitiva.

## Evidencia disponible

- Confirmado: el backend es una API Express y expone `GET /health`, que responde `200` con `{ "status": "ok" }`.
- No confirmado: no existen en el repositorio rutas, esquemas ni documentación implementada para identidad, sesión o lotes.
- No confirmado: no se ha decidido si la autenticación usará cookies, tokens u otro mecanismo. El frontend no debe almacenar ni enviar credenciales de sesión hasta acordarlo.

## Convenciones propuestas

- Prefijo y formato: las rutas siguientes son propuestas relativas a la URL base configurada en `VITE_API_BASE_URL`.
- Cuerpos exitosos: JSON UTF-8 cuando contengan datos. `204 No Content` es una respuesta válida para cierre de sesión.
- Desarrollo local: el ejemplo de frontend usa `VITE_API_BASE_URL=/api`; Vite reenvía ese prefijo al backend local `http://localhost:3000` y elimina `/api`. En otro entorno, la URL base debe configurarse según su proxy o despliegue.
- Errores: el cliente debe usar el estado HTTP y tolerar cuerpos vacíos, texto o JSON. Una posible envoltura `{ "error": { "code", "message" } }` requiere validación previa; no está confirmada.
- Fechas: si se acuerdan, se transportarían como texto ISO 8601. Este formato tampoco está confirmado.

## Operaciones propuestas

### Registro

| Campo | Propuesta |
| --- | --- |
| Método y ruta | `POST /auth/register` |
| Parámetros | Ninguno en URL. |
| Cuerpo | `{ "email": string, "password": string, "displayName"?: string }` |
| Respuesta esperada | `201 Created` con `{ "user": Identity }`. No se presupone que cree una sesión. |
| Errores relevantes | `400` o `422` por datos inválidos; `409` por correo ya registrado. Códigos y cuerpo pendientes de confirmación. |

Dudas: reglas de contraseña, normalización de correo, obligatoriedad y nombre de la etiqueta visible, roles iniciales y activación de cuenta.

### Inicio de sesión

| Campo | Propuesta |
| --- | --- |
| Método y ruta | `POST /auth/login` |
| Parámetros | Ninguno en URL. |
| Cuerpo | `{ "email": string, "password": string }` |
| Respuesta esperada | `200 OK` con `{ "session": Session }`. La forma en que se mantiene esa sesión (cookie, token u otra) está pendiente de decisión. |
| Errores relevantes | `400` o `422` por formato inválido; `401` por credenciales no válidas; posible `429` por limitación. Todos pendientes de confirmación. |

### Consulta de sesión

| Campo | Propuesta |
| --- | --- |
| Método y ruta | `GET /auth/session` |
| Parámetros y cuerpo | Ninguno. El mecanismo para asociar la solicitud con una sesión no está definido. |
| Respuesta esperada | `200 OK` con `{ "session": Session }`. |
| Errores relevantes | `401 Unauthorized` si no hay sesión válida; formato de respuesta pendiente de confirmación. |

### Cierre de sesión

| Campo | Propuesta |
| --- | --- |
| Método y ruta | `POST /auth/logout` |
| Parámetros y cuerpo | Ninguno. |
| Respuesta esperada | `204 No Content`; el cliente debe aceptar la ausencia de cuerpo. |
| Errores relevantes | Puede ser `401` si el backend exige una sesión activa. La idempotencia y los códigos definitivos deben validarse. |

### Listado de lotes

| Campo | Propuesta |
| --- | --- |
| Método y ruta | `GET /lotes` |
| Parámetros | Ninguno confirmado. Si se incorpora paginación, se propone evaluar `cursor` y `limit`; filtros, orden y sus nombres quedan abiertos. |
| Cuerpo | Ninguno. |
| Respuesta esperada | `200 OK` con `{ "items": LotSummary[], "nextCursor"?: string | null, "total"?: number }`. Esta envoltura y los campos de cada lote son propuestos. |
| Errores relevantes | `400` por consulta inválida y `500`/`503` por disponibilidad, pendientes de confirmación. |

Dudas: estados posibles, visibilidad de lotes, campos obligatorios, unidad y formato de cantidad, ubicación, vencimiento, filtros, orden y paginación.

### Detalle de un lote

| Campo | Propuesta |
| --- | --- |
| Método y ruta | `GET /lotes/:id` |
| Parámetros | Ruta: `id` de lote, tipo y formato pendientes de definición. |
| Cuerpo | Ninguno. |
| Respuesta esperada | `200 OK` con `{ "lot": Lot }`. La envoltura es propuesta. |
| Errores relevantes | `400` por identificador inválido, `404` si no existe y `403` si hay reglas de visibilidad; todos pendientes de confirmación. |

## Tipos del frontend

Los tipos propuestos se encuentran en `web/src/services/api-types.ts`. Son deliberadamente conservadores: los estados se modelan como texto hasta acordar un catálogo y los campos opcionales reflejan información de dominio aún no definida.

## Pendientes para backend

1. Validar rutas, códigos de estado y envolturas JSON.
2. Definir autenticación, duración y revocación de sesión, CORS y protección CSRF si corresponde.
3. Definir el modelo de usuario: roles, nombre visible y campos obligatorios.
4. Definir modelo y ciclo de vida de lote: estados, cantidades, alimentos, ubicación, disponibilidad y permisos.
5. Definir filtros, orden, paginación y límites del listado.

## Decisión de dominio posterior a E1

[ADR 0002](adr/0002-ofertas-parciales.md) permite ofrecer la cantidad disponible
a la primera solicitud aunque sea menor que la solicitada. Aceptar confirma solo
lo ofrecido y cierra la solicitud en cola sin prioridad residual. Los contratos
futuros de solicitudes/ofertas/reservas deberán distinguir las cantidades
solicitada, ofrecida y confirmada, y comunicar ese cierre antes de aceptar.
La cantidad publicada de un lote no equivale a su disponibilidad asignable.

Rechazar o dejar vencer sin respuesta también cierra la solicitud y la saca de
la cola sin prioridad residual. No genera otra solicitud automáticamente: volver
a solicitar exige una nueva acción explícita y una nueva posición FIFO.

Se mantiene como riesgo futuro la representación de solicitudes posteriores
sobre el mismo lote: K003 limita a un compromiso confirmado por usuario/lote y
el modelo de solicitud/oferta/reingreso deberá resolver esa compatibilidad. Este registro no agrega operaciones, campos de transporte ni
implementación al contrato propuesto de identidad y lotes.
