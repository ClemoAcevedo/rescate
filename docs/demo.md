# Demo de entrega y recorridos

La demo final se presenta en producción con cuentas y lotes ficticios del establecimiento
«Panadería Demo Rescate». Recorre RF01 a RF13 con tres cuentas separadas: publicación con
foto, búsqueda, reserva, espera con oferta, cancelación, chat, retiro, una incidencia
después de entregar, vencimientos y el panel. Cada paso usa las funciones del
[manual](manual.md). Los recorridos moderados con personas siguen el
[protocolo de accesibilidad](accesibilidad.md#protocolo-de-cinco-recorridos) en una
instancia local.

## Cuentas

| Cuenta | Rol en la demo |
| --- | --- |
| `operador.e3@rescate.test` | Operador de «Panadería Demo Rescate»: publica, chatea, valida el retiro, gestiona la incidencia y abre el panel |
| `persona.a.e3@rescate.test` | Persona A: reserva el lote completo y luego cancela |
| `persona.b.e3@rescate.test` | Persona B: espera, acepta la oferta, chatea, retira y reporta un problema |

Las tres usan la misma contraseña, que el equipo comparte por un canal privado; no se
guarda en el repositorio. El dominio `.test` no recibe correo, por lo que una
contraseña olvidada no se recupera: se registra otra cuenta.

Las cuentas se registran por la web o `POST /auth/register` y no obtienen permisos.
La membership del operador se crea con SQL desde la consola del servicio `postgres` en
Railway, porque la API no administra establecimientos ([despliegue](despliegue.md)):

```sql
INSERT INTO memberships (user_id, establishment_id)
SELECT u.id, e.id FROM users u, establishments e
WHERE u.email = 'operador.e3@rescate.test' AND e.name = 'Panadería Demo Rescate';
```

Las demás cuentas de producción no se usan en la demo. La de smoke pertenece al
pipeline de despliegue.

## Preparación

**Antes del día.** Ensayar el guion completo, primero en local (ver más abajo) y luego en
producción. El ensayo en producción confirma que las tres sesiones desde una misma red no
alcanzan los [límites de tráfico](seguridad.md#límites). Una grabación sirve de apoyo, pero
no reemplaza a la [alternativa local](#si-producción-falla). Tener a mano una foto del pack
(JPEG, PNG o WebP de hasta 5 MiB).

`npm --prefix api run demo` prepara datos por la API pública con las cuentas de la demo,
igual que la web. Exige `WEB_URL` (el origen HTTPS, sin ruta) y `DEMO_PASSWORD`, y se
detiene si el establecimiento ya tiene un lote con la ventana abierta, para que el panel y
la búsqueda muestren un solo lote durante el guion. `--foto` agrega una foto antes de
publicar.

```bash
WEB_URL=https://rescate-rescate1.vercel.app DEMO_PASSWORD='…' \
  npm --prefix api run demo -- previo --foto pan.jpg
```

**Al menos una hora antes.** Pasar la [comprobación de producción](#comprobación-de-producción)
y dejar en marcha la [alternativa local](#si-producción-falla). El panel muestra por
defecto los últimos 7 días con hoy incluido y solo cuenta lotes cerrados ([panel](panel.md)). `previo` publica un lote de 2
packs cuya ventana termina en 20 minutos (`--minutos`): A reserva 1 pack y el operador
registra su retiro; B reserva el otro y no lo retira. Al cerrar, B tiene una reserva
«Vencida» (RF08) y el período muestra ese lote: 1 pack retirado, 1 no asignable, una
reserva retirada y una vencida.

**Minutos antes.** Abrir un contexto de navegador independiente por cuenta con la sesión
iniciada. Usar A y B en ancho móvil y el operador en escritorio. Si no habrá tiempo para
publicar en vivo, `en-vivo` deja publicado el lote del guion (2 packs, ventana de 3 horas,
`--horas`) con los 2 packs reservados por A: el paso 2 se muestra sobre ese lote ya
publicado y el paso 3 sobre la reserva ya hecha.

## Guion

| Paso | Quién | Qué se muestra | RF |
| --- | --- | --- | --- |
| 1. Cuentas | Todos | En una ventana privada aparte, crear una cuenta ficticia con un correo nuevo y aceptar el consentimiento. Mostrar la confirmación al llegar a «Iniciar sesión». En las sesiones preparadas, el operador ve «Mi establecimiento» y A y B ven los grupos «Rescatar» y «Tu cuenta». | RF01 |
| 2. Publicación | Operador | Guardar un borrador de 2 packs con título y categoría propios. La ventana debe estar abierta durante la presentación. Usar «Agregar foto», esperar a que esté lista y pulsar «Publicar lote» y «Confirmar publicación». | RF02 |
| 3. Búsqueda y reserva | A | En «Explorar lotes» filtrar por la categoría del recorrido y comprobar el título. Mostrar la foto, «Tu retiro» y las condiciones. Pulsar «Agregar un pack» para pasar de 1 a 2, luego «Reservar 2 packs» y «Ver mi código de retiro». | RF03, RF04 |
| 4. Espera | B | El lote muestra «Sin packs libres». «Unirme a la lista de espera» por 1 pack; «Mis esperas» muestra su lugar. La espera no retiene packs. | RF07 |
| 5. Cancelación y oferta | A, luego B | A elige «Cancelar reserva» y «Confirmar cancelación». El código deja de servir. B abre «Ver oferta» en «Avisos» o entra al detalle desde «Mis esperas» si el aviso demora. Pulsa «Aceptar 1 pack» antes de que venza el plazo de diez minutos y abre «Ver mi código de retiro». | RF05, RF07, RF09 |
| 6. Chat | B y operador | B abre «Chat de la reserva» y escribe. El operador recibe el aviso del mensaje y responde desde «Avisos» o los compromisos de «Mi establecimiento». | RF13, RF09 |
| 7. Retiro | Operador | «Validar retiros»: escribe el código que muestra B, «Revisar código» y «Confirmar retiro de 1 pack». La conversación queda cerrada. | RF06 |
| 8. Incidencia | B, operador, A | B elige «Reportar un problema» en su reserva retirada. El operador la ve en «Incidencias por revisar», la publica con instrucciones y ve los avisos pendientes, generados y leídos. B (con entrega) y A (sin entrega) reciben el «Aviso de incidencia»; B lo marca como leído. El operador pulsa «Actualizar» para comprobar la lectura, selecciona «Resolver la incidencia» en «Acción» y pulsa «Resolver incidencia». | RF11, RF09 |
| 9. Vencimiento | B | «Mis reservas» muestra la reserva de `previo` como «Vencida», sin código. | RF08 |
| 10. Panel | Operador | «Mi establecimiento»: el lote con 1 pack retirado y 1 libre, compromisos e historial de la sesión, y los resultados del período con las tasas de retiro y de vencimiento. | RF10, RF12 |

Si vence la oferta, B pierde su lugar. Cuando los packs quedan libres y la cola está vacía,
el lote vuelve a admitir reserva directa. Para repetir la espera, vuelve al paso 3 con A
reservando los dos packs. Tras el retiro se puede demostrar que la conversación queda cerrada
y que revisar el mismo código muestra la reserva como «Retirada».

## Comprobación de producción

Se hace el día anterior y otra vez al menos una hora antes. Incluye consultas de producción
y la comprobación de inicio y cierre de sesión con las cuentas de prueba.

| Qué | Cómo | Resultado esperado |
| --- | --- | --- |
| Release | `curl -s https://rescate-rescate1.vercel.app/release.json` | `commit` igual a la última etiqueta, después de `git fetch --tags`: `git tag -l 'deploy-*' --sort=-creatordate \| head -1` |
| Salud | `curl -s https://rescate-rescate1.vercel.app/api/health` | `status`, `database` y `worker` en `ok` ([salud](operacion.md#salud)) |
| Trayecto HTTPS | `WEB_URL=https://rescate-rescate1.vercel.app DEPLOY_SHA=<commit> npm --prefix api run test:deploy` | Todas las comprobaciones en `PASS` |
| Worker, tareas y copia | `NODE_ENV=production npm --prefix api run ops:status`, con `DATABASE_URL` por el túnel SSH y las variables `PHOTO_S3_*` del servicio `api` ([revisión diaria](operacion.md#revisión-diaria)) | Worker activo, sin tareas en error y copia diaria vigente |
| Cuentas | Iniciar sesión con las tres cuentas | El operador ve «Mi establecimiento»; A y B no |
| Lotes | «Mis lotes» del operador | «Panadería Demo Rescate» tiene cero lotes con la ventana abierta antes de `previo` |

Si una fila falla y no se corrige antes de la presentación, la demo usa la alternativa
local.

## Si producción falla

La alternativa es la instancia del [ensayo local](#ensayo-local): no depende de Railway,
Vercel ni B2, y solo tiene cuentas y datos ficticios.

1. Antes de presentar, `npm --prefix api run recorridos:e3`, y luego `preparar P01` y
   `preparar P02`. La web queda en `https://localhost:5174`.
2. Iniciar sesión con las tres cuentas locales en ventanas separadas. Después de ejecutar
   ambos comandos `preparar`, dejar un borrador para el recorrido con 2 packs, foto validada,
   título y categoría propios. Antes de proyectar, verificar que su ventana cubra la demo.
3. Para los pasos 9 y 10, publicar otro lote local de 2 packs con título distinto y una ventana
   corta. A reserva 1 y el operador registra su retiro. B reserva el otro y confirma en
   «Mis reservas» que venció antes de presentar. Los resultados del período también cuentan
   los lotes que retira `preparar`. Mostrar el vencimiento y el retiro del lote preparado.
4. Si producción falla, anunciar el cambio a la instancia local y retomar desde el último
   estado preparado allí. Si el punto de partida local es el borrador, continuar desde el
   paso 2 y resumir lo que ya se mostró. Para retomar más adelante, preparar y verificar de antemano el estado
   correspondiente con las cuentas locales, por ejemplo la reserva confirmada de B para
   abrir el chat y validar su retiro. Ensayar el cambio de ventanas antes de presentar.

## Fuera de la demo

No se muestran ni se anuncian como disponibles:

- Recuperación de contraseña y administración de establecimientos y memberships desde
  la aplicación.
- Coordenadas precargadas o elegidas en un mapa ([#97](https://github.com/ClemoAcevedo/rescate/issues/97)).

## Ensayo local

La instancia de los recorridos sirve para ensayar el guion sin tocar producción. Las cuentas
cambian, pero los pasos son los mismos:

1. `npm --prefix api run recorridos:e3` levanta la instancia en `https://localhost:5174`
   (ver [recorridos moderados](#recorridos-moderados)) e imprime la contraseña local.
2. `preparar P01` y luego `preparar P02` registran `participante.p01@example.test` (A) y
   `participante.p02@example.test` (B). El operador es `operador.recorridos@example.test`,
   de «Panadería de prueba».
3. Se recorre el guion desde el paso 1 en tres ventanas. Los dos lotes de `preparar P02`
   siguen visibles en «Explorar lotes»; el guion usa el que publica el operador en el paso 2.
4. Los pasos 9 y 10 dependen de `previo`, que solo se prepara en producción: en local, el
   vencimiento se ve al publicar un lote con una ventana corta y esperar su cierre.
5. `salir` detiene los servicios.

## Recorridos moderados

Los cinco recorridos usan la consigna, las preguntas y la ficha del
[protocolo](accesibilidad.md#protocolo-de-cinco-recorridos), con participantes ajenos a
la implementación. Las fichas anonimizadas se guardan fuera de `docs/` y se enlazan
desde el PR.

`npm --prefix api run recorridos:e3` levanta la instancia en `https://localhost:5174`:
crea una base dedicada en el PostgreSQL de Compose (o en `DATABASE_URL`), la migra e
inicia API, worker y Vite con un certificado efímero que el navegador pide aceptar.
Registra el operador de «Panadería de prueba» y dos cuentas de apoyo, y espera
comandos en la terminal:

| Comando | Cuándo | Efecto |
| --- | --- | --- |
| `preparar P01` | Antes de cada sesión | Registra `participante.p01@example.test`, retira los lotes abiertos del participante anterior y publica dos: uno de 6 packs disponible y otro de 10 sin packs libres, reservado por las cuentas de apoyo (4 + 6). |
| `ofrecer P01` | Justo antes del recorrido 5 | Cancela la reserva de apoyo de 4 packs; la cola ofrece esos 4 de los 10 que pidió el participante en el recorrido 4. Falla si el participante no está esperando. |
| `salir` | Al terminar | Detiene los servicios y conserva la base. Ctrl+C hace lo mismo. |

Todas las cuentas usan la contraseña pública que imprime el comando; existen solo en
esa base. El moderador inicia la sesión del participante antes de empezar y no
registra la contraseña ni el código de retiro en la ficha. La oferta dura diez
minutos y el worker la vence a su hora; si vence, se repiten los recorridos 4 y 5 con
`preparar`.
