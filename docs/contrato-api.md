# Contrato API propuesto: identidad y lotes

> Estado: **antecedente histórico de K004, sustituido por OpenAPI S02**.
> Este documento no define la API de forma definitiva. Se conserva para trazabilidad.
> La fuente de verdad es [openapi.yaml](api/openapi.yaml), con [decisiones y guía](api/README.md).
> Las propuestas, dudas y evidencia de abajo conservan el contexto original;
> no son decisiones pendientes si la guía S02 ya las resolvió. Los endpoints de
> negocio aún no están implementados.

**Aclaración de fuentes (2026-09-21):** los [anexos E1](entregas/e1/anexos-e1.pdf),
H p. 21, ya definen contraseña de al menos 12 caracteres con scrypt,
sesión opaca persistida en PostgreSQL con vigencia de
12 horas, cookie HttpOnly/Secure/SameSite Lax, token CSRF y validación de origen.
No están implementados. Las dudas originales de K004 sobre elegir cookies o tokens
no reabren esas decisiones; K008 debe concretarlas junto a su contrato HTTP.
Las rutas, cuerpos y códigos siguientes siguen siendo propuestas, no operaciones
aprobadas por esta aclaración. Véase la [arquitectura](arquitectura/arquitectura.md).

## Evidencia disponible

- Confirmado: el backend es una API Express y expone `GET /health`, que responde `200` con `{ "status": "ok" }`.
- No confirmado: no existen en el repositorio rutas, esquemas ni documentación implementada para identidad, sesión o lotes.
- Definido en E1, todavía no implementado: sesión opaca persistida y cookie protegida. El frontend no debe integrar credenciales hasta concretar el contrato y su protección en K008.

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

Dudas: detalles adicionales de validación de contraseña respetando E1, normalización de correo, obligatoriedad y nombre de la etiqueta visible, representación de permisos y habilitación de cuenta.

### Inicio de sesión

| Campo | Propuesta |
| --- | --- |
| Método y ruta | `POST /auth/login` |
| Parámetros | Ninguno en URL. |
| Cuerpo | `{ "email": string, "password": string }` |
| Respuesta esperada | `200 OK` con `{ "session": Session }`, cuerpo aún propuesto. E1 define sesión opaca y cookie protegida; sus detalles HTTP se concretarán en K008/OpenAPI. |
| Errores relevantes | `400` o `422` por formato inválido; `401` por credenciales no válidas; posible `429` por limitación. Todos pendientes de confirmación. |

### Consulta de sesión

| Campo | Propuesta |
| --- | --- |
| Método y ruta | `GET /auth/session` |
| Parámetros y cuerpo | Ninguno propuesto. La asociación mediante cookie de sesión está prevista por E1; el contrato concreto sigue pendiente de implementación. |
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

Existen tipos preliminares en [services/api-types.ts](../web/src/services/api-types.ts)
y [types/api.ts](../web/src/types/api.ts), con diferencias entre sí. No son fuentes
de verdad definitivas ni modelos de base de datos. Los estados como texto y campos
opcionales requieren reconciliación con E1, el modelo inicial y las tarjetas.
Al incorporar generación desde OpenAPI se sustituirán/consolidarán esos catálogos,
sin mantener definiciones HTTP manuales paralelas. Este PR no modifica TypeScript.

## Pendientes para backend

1. Validar rutas, códigos de estado y envolturas JSON.
2. Materializar la autenticación y vigencia de sesión definidas en E1; concretar revocación, cookies, CORS, CSRF y origen para desarrollo y producción.
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
