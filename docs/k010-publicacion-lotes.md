# K010 — Borrador y publicación de lotes

Tarjeta K010 (RF02). Responsable: Felipe Arnolds. Revisor: Clemente Acevedo.
Depende de K003. Alcance: crear borradores, editarlos con versión optimista,
publicarlos y consultarlos. No incluye fotos, retiro del lote con motivo,
búsqueda pública ni reserva.

## Decisiones tomadas en esta tarjeta

### Borrador completo, sin guardado parcial

El [modelo inicial](modelo-inicial.md) y la
[guía de arquitectura](arquitectura/arquitectura.md) dejaron abierto si el
borrador admite campos pendientes. K010 mantiene la declaración completa desde la
creación: contenido, categoría, cantidad, dirección, ubicación, zona horaria y
ventana. Las condiciones siguen siendo opcionales, como en K003.

Motivo: un borrador incompleto obliga a hacer nullable media tabla y a duplicar
las reglas de RF02 en dos momentos distintos. Guardar un formulario a medias es
una necesidad de interfaz que K011 puede resolver en el navegador. Si el equipo
decide persistir borradores parciales, requerirá una migración y una revisión de
las reglas de publicación; no se asume aquí.

### Identificador público opaco

E1 (anexos B p. 4) exige identificadores públicos opacos y la guía de
arquitectura advierte que no se exponga el `bigint` interno. La migración de esta
tarjeta agrega `lots.public_id uuid` con valor por omisión `gen_random_uuid()` y
unicidad. El contrato HTTP usa ese identificador; la clave interna no sale de la
base. Los identificadores de establecimiento todavía se transportan como texto
numérico, porque `establishments` no tiene aún su identificador público.

### Versión optimista del borrador

Se agrega `lots.version integer NOT NULL DEFAULT 1`. Cada edición y la
publicación la incrementan. El cliente envía `expectedVersion`; si no coincide
con la vigente, la operación responde `409 version_conflict` y no escribe.

Anexos C p. 5 propone exactamente esto para borradores: versión y rechazo por
conflicto, porque la persona puede revisar su edición. El bloqueo pesimista queda
reservado para inventario y asignación, que no son parte de K010.

### Inmutabilidad después de publicar

RF02 indica que, publicado el lote, no cambian cantidad, contenido, lugar ni
plazo. Editar un lote publicado responde `409` con la regla
`published_lot_is_immutable`. Corregir exige retirar y crear otro lote; retirar
con motivo no está implementado todavía y corresponde a una tarjeta posterior.

### Ventana de retiro vencida

Publicar un lote cuya ventana ya terminó responde `409` con
`pickup_window_already_ended`. H p. 20 permite reservar desde la publicación
hasta el cierre: publicar después del cierre dejaría una oferta que nadie puede
retirar. La comprobación usa el instante leído dentro de la transacción, después
de bloquear la fila.

### Autenticación: punto de conexión, no implementación

K008 implementa sesión, cookie y CSRF; todavía no está integrada. K010 define el
límite y **no** inventa un mecanismo propio: sin K008, toda operación responde
`401 not_authenticated`.

Para poder ejercitar los endpoints en desarrollo existe un actor explícito por
cabecera `X-Rescate-Dev-Actor`, **deshabilitado salvo que `RESCATE_DEV_ACTOR`
valga `enabled`**, y que falla al arrancar si `NODE_ENV=production`. No verifica
credenciales ni es un mecanismo de autenticación. Al integrar K008 se sustituye
la función `selectAuthentication` por la resolución real de sesión y se elimina
esta variable.

### Un lote ajeno responde 404

La autorización comprueba la pertenencia real del actor al establecimiento del
lote. Un operador de otro establecimiento recibe `404`, no `403`, para no
confirmar la existencia de datos ajenos. La distinción entre "no existe" y "no
autorizado" se conserva dentro del caso de uso.

## Contrato HTTP

Todas las operaciones requieren actor autenticado. Los cuerpos son JSON con
límite de 16 KB (H p. 20) y los instantes son ISO 8601 con zona explícita.

| Operación | Ruta | Resultado |
| --- | --- | --- |
| Crear borrador | `POST /lots` | `201` con el lote en estado `draft` y versión 1 |
| Listar del establecimiento | `GET /lots?establishmentId=&status=` | `200` con `items` |
| Consultar un lote | `GET /lots/:id` | `200` con el lote |
| Editar borrador | `PATCH /lots/:id` | `200` con la versión incrementada |
| Publicar | `POST /lots/:id/publication` | `200` con estado `published` |

La publicación es un recurso propio y no un `PATCH` de estado: es una transición
con reglas propias, no la edición de un campo.

### Errores

| Código HTTP | `error.code` | Cuándo |
| --- | --- | --- |
| 400 | `invalid_request` | La entrada no tiene la forma esperada: tipo incorrecto, fecha sin zona o campo ausente. `violations` nombra los campos. |
| 401 | `not_authenticated` | No hay sesión válida. |
| 404 | `lot_not_found`, `not_authorized` | El lote no existe, o pertenece a otro establecimiento. |
| 409 | `version_conflict` | La versión enviada ya no es la vigente. |
| 409 | `lot_state_conflict` | El estado o el instante impiden la transición: lote publicado o ventana terminada. |
| 422 | `invalid_lot` | Los datos no cumplen las reglas de RF02. `violations` nombra todas las incumplidas, no solo la primera. |

Una cantidad como texto (`"3"`) es `400`, no `422`: el servidor no convierte
tipos en silencio. Una cantidad `0` sí es `422`, porque la forma es correcta y la
regla de negocio es la que falla.

## Recorrido y responsabilidades

```text
POST /lots/:id/publication
  http/lots-router.ts        valida forma, obtiene el actor, traduce el resultado
  application/lots/use-cases comprueba pertenencia y versión, define la atomicidad
  domain/lots.ts             decide si la transición es válida en ese instante
  infrastructure/postgres    bloquea la fila, relee, escribe y confirma
```

`src/composition.ts` arma Pool, repositorio, casos de uso y router. Domain no
importa HTTP, Application ni pg. HTTP no ejecuta SQL.

## Pruebas

| Prueba | Comando | Cubre |
| --- | --- | --- |
| Reglas puras | `npm test` (`test/lots-domain.test.ts`) | Cantidades, ventana, ubicación, zona horaria, publicación e inmutabilidad, sin base ni HTTP. |
| Recorrido HTTP | `npm test` (`test/lots-http.test.ts`) | HTTP → Application → Domain con repositorio en memoria: contrato, errores, autorización, versión y actor deshabilitado. |
| Integración PostgreSQL | `npm run db:test:lots:compose` | Repositorio real, transacciones, publicación concurrente, rollback y reaplicación de la migración. |
| Migraciones | `npm run db:test:compose` | Historial completo de K002, K003 y K010 desde base vacía. |

La prueba de integración exige una base dedicada `rescate_k010_test_*` creada
vacía, igual que K003. No se ejecuta contra la base de desarrollo.

## Pendiente y fuera de alcance

- Sustituir el actor de desarrollo por la sesión de K008 y retirar
  `RESCATE_DEV_ACTOR`.
- Fotos del lote: K014 integra la carga; K010 no las exige ni las bloquea.
- Retirar un lote publicado con motivo, estados `closed` y `expired`.
- Identificador público de establecimientos.
- OpenAPI: ADR 0003 lo fija como contrato versionado de S02. Esta tarjeta
  documenta su superficie aquí; generar el documento y derivar tipos sigue
  pendiente y conviene acordarlo con K009 y K011.
- Compose no ejecuta migraciones al arrancar: la API espera un esquema ya
  migrado, según el despliegue en una etapa controlada de E1.
