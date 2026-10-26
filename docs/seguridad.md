# Seguridad: límites, aislamiento y registros (RNF05)

Cómo la API limita intentos, aísla cada objeto por actor y mantiene los registros sin
secretos (informe E1 p. 3; anexos C p. 5 y H pp. 20–23). Cookies, CSRF, Origin y
sesiones están en [identidad](k008-identidad.md); el contrato, en
[OpenAPI](api/openapi.yaml).

## Límites

Todos responden 429 `RATE_LIMITED` con `Retry-After` en segundos. Los límites en memoria
acotan sus claves: con el mapa lleno, una clave nueva recibe 503.

| Límite (H p. 21) | Dónde se cobra | Dónde vive |
| --- | --- | --- |
| Escrituras: 120 solicitudes/min por usuario, ráfaga 20 | Al resolver la sesión, en métodos distintos de GET y HEAD | Memoria del proceso |
| Lecturas: 300 solicitudes/min por usuario, ráfaga 60 ([ADR 0014](adr/0014-cupo-de-lecturas-por-usuario.md)) | Al resolver la sesión, en GET y HEAD | Memoria del proceso |
| 3000 solicitudes/min por IP, ráfaga 100 | Todas las rutas salvo `/health` | Memoria del proceso |
| Login: 5 fallos por cuenta en 15 min bloquean 15 min | Application de identidad | PostgreSQL (`login_security_state` y `login_failures`) |
| Login: 30 intentos por IP en 15 min | `POST /auth/login` | Memoria del proceso |
| Código de retiro: 5 fallos por operador en 15 min suspenden 15 min | Application de reservas, al revisar y al confirmar | PostgreSQL (`pickup_code_security_state` y `pickup_code_failures`) |
| Código de retiro: 30 revisiones por IP por minuto | Application de reservas, después del permiso y antes de comparar el código | Memoria del proceso |
| Mensajes de chat: 12/min por usuario, ráfaga 3 | `limits.message`; lo aplica K037 (#40) | Memoria del proceso |

Los límites en memoria se reinician con la API y se multiplican si hay varias
instancias: H p. 21 los describe como protección de una sola API, no como defensa
distribuida. Los fallos de login y de código se guardan en PostgreSQL, así que
sobreviven a un reinicio y valen para todos los procesos.

**Códigos de retiro.** Cuenta como fallo un código que no corresponde a una reserva del
lote; el código válido de una reserva terminada no. Durante la suspensión, revisar y
confirmar responden 429 antes de buscar el código, también con el correcto, y no suman
fallos ni extienden el plazo. El límite es del operador, no del lote. Confirmar cuenta
igual que revisar, también en la ventana por IP, y esa ventana solo la gastan operadores
con membership del lote. Decisión y alternativas en
[ADR 0013](adr/0013-limite-de-codigos-de-retiro.md).

**Origen.** La IP es la del socket: la API no confía en `X-Forwarded-For` y cambiar
esa cabecera no evade un límite. Detrás del proxy de producción todos los clientes
pueden compartir esa IP. Entonces la ventana de login por IP es común a todos, y quien
la agote bloquea el login de los demás durante 15 minutos; la de códigos es común a los
operadores autorizados (#141).

## Aislamiento por objeto

El actor sale solo de la sesión; el identificador público de un objeto nunca concede
acceso. Cada caso de uso comprueba propiedad o membership sobre el objeto pedido.

| Objeto | Quién accede | Un ajeno recibe |
| --- | --- | --- |
| Reserva y su código, solicitud de la cola, aviso | Su titular (`user_id` en la consulta) | 404, igual que un objeto inexistente |
| Lote no publicado, gestión de sus fotos, listado y alta de lotes del establecimiento | Operador con membership | 403 |
| Imagen de una foto de un lote no publicado | Operador con membership | 404, igual que una inexistente |
| Revisión y retiro de códigos | Operador con membership del lote | 403; un código de otro lote, 404 |
| Lote publicado, su detalle y sus fotos | Cualquiera | — |

En las rutas del operador, un lote o establecimiento ajeno responde 403 y uno
inexistente 404, como fija el contrato; con UUID aleatorios eso no permite enumerar
lotes.

## Registros sin secretos

Los registros llevan eventos con valores primitivos (`Log` en
[logging.ts](../api/src/application/logging.ts)): el tipo impide registrar el error, la
solicitud o un objeto. De un error solo se registra `errorCode`: un SQLSTATE, un error
de sistema conocido o un `ERR_*` de Node. Cualquier otro valor, incluido uno con la forma
de un código de retiro, queda como `INTERNAL`.

Nunca se registran contraseñas, cookies, tokens CSRF, códigos de retiro (tampoco los
tecleados), claves, `DATABASE_URL`, cuerpos, SQL ni correos. Un fallo después de
enviar cabeceras registra solo su código y corta la respuesta: no llega al manejador
de Express, que imprimiría el stack. Las respuestas no anuncian `X-Powered-By` y
llevan `X-Content-Type-Options: nosniff`.

Todo evento nuevo usa el mismo tipo y el sumidero único que recibe `createApi`. La
línea de cada solicitud lleva la plantilla de la ruta, nunca la URL con valores, sus
cabeceras ni su cuerpo, y un identificador generado ([operación](operacion.md)).

## Pruebas

| Comando | Qué comprueba |
| --- | --- |
| `npm --prefix api test` | Regla de cinco fallos, limitadores por IP y de mensajes, suspensión al revisar y confirmar con repositorio en memoria, y registros sin detalle de PostgreSQL ni cuerpos. |
| `npm --prefix api run db:test:security:compose` | PostgreSQL y API reales: reservas, ofertas, avisos, lotes, fotos y retiros ajenos rechazados sin cambios en la base; cinco fallos de código suspenden también con el código correcto y siguen tras reiniciar la API; diez intentos simultáneos registran cinco; el límite por IP no lo gastan cuentas sin permiso; revocación al cerrar sesión, cookies duplicadas, Origin y CSRF en comandos, login y logout; `X-Forwarded-For` ignorado; cabeceras; salida de la API sin secretos. |
| `npm --prefix api run db:test:compose` | Restricciones de las tablas de intentos y su rollback. |

## Limitaciones

- La IP detrás del proxy de producción (#141).
- El registro de cuentas no tiene límite propio; ráfagas de registro pueden ocupar los
  dos cálculos de scrypt y hacer responder 503 al login (#142).
- Editar, publicar y cargar fotos bloquean la fila del lote antes de comprobar la
  membership (#143).
