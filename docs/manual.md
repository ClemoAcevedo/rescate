# Manual de uso

Rescate conecta establecimientos que publican excedentes del día en packs con personas que
los reservan y los retiran en el local. Este manual describe cada función con los textos que
muestra la aplicación. La correspondencia con los requisitos está al final.

Hay dos roles. **Quien rescata** explora, reserva, espera y retira packs. **El operador**
publica lotes de su establecimiento, valida retiros y sigue los resultados. Una misma cuenta
puede tener ambos roles.

El menú agrupa las secciones en «Rescatar» (Explorar lotes, Mis esperas, Mis reservas), «Mi
establecimiento» (solo para operadores: el panel, Mis lotes y «Publicar lote») y «Tu cuenta»
(Avisos, el correo de la sesión y «Cerrar sesión»). En pantallas angostas se abre con «Abrir
menú».

## Cuenta y acceso

- **Registro.** En «Registro» se ingresa correo, una contraseña de al menos 12 caracteres y
  el consentimiento «Acepto que Rescate guarde mi correo…». Registrarse no inicia sesión:
  después se entra por «Iniciar sesión».
- **Sesión.** Dura 12 horas desde el inicio de sesión. Las páginas que la requieren ofrecen
  «Iniciar sesión» y, al entrar, vuelven a la misma página.
- **Operar un establecimiento.** Registrarse no da permisos de operador. La habilitación la
  hace el equipo por separado; mientras no exista, las páginas de operación muestran «Tu
  cuenta todavía no está habilitada para operar un establecimiento».
- **Explorar sin cuenta.** «Explorar lotes» y el detalle de un lote no exigen sesión;
  reservar o esperar sí.

## Para quien rescata

### Explorar lotes

«Explorar lotes» lista los lotes publicados con la ventana de retiro abierta, de 12 en 12. Se
filtra por categoría, por «Retiro comienza antes de» y por zona: «Usar mi ubicación» o
«Ingresar coordenadas», con un radio. Con zona, los lotes más cercanos aparecen primero y las
distancias son aproximadas; sin zona, primero los más recientes. Cada tarjeta indica los packs
libres o «Sin packs libres». El detalle muestra fotos, «Qué incluye», «Tu retiro» (lugar y
horario en la zona del local) y «Condiciones del lote».

### Reservar

En el detalle, «Reserva tus packs» permite elegir de 1 a los packs libres y confirmar con
«Reservar N packs». La reserva es inmediata: «Reservaste N packs» y «Ver mi código de retiro».
Una persona tiene una sola reserva o espera vigente por lote. Si no hay packs suficientes, el
detalle ofrece la lista de espera.

### Ver el código y retirar

«Mis reservas» lista las reservas vigentes y terminadas. El detalle muestra el estado, el
«Código de retiro» («Muéstralo en el local al retirar»), la cantidad, el lugar y la ventana. En
el local, el operador escribe ese código y registra la entrega; la reserva pasa a «Retirada».
Al terminar la ventana el código deja de mostrarse.

### Cancelar

En el detalle de la reserva, «Cancelar reserva» pide confirmar: «¿Cancelar esta reserva? Los
packs quedarán libres para otras personas y tu código dejará de servir». «Conservar reserva»
deja todo igual; «Confirmar cancelación» la cancela y los packs se ofrecen a quien espera. No se
puede cancelar una reserva retirada o vencida.

### Lista de espera y ofertas

Si el lote no tiene packs suficientes, «Unirme a la lista de espera» registra cuántos packs se
necesitan. Estar en la lista no reserva packs; «Mis esperas» muestra «Tu lugar en la lista».
Cuando se liberan packs, la primera persona recibe una oferta, que puede ser por menos de lo
pedido, y un aviso. La oferta dura diez minutos o hasta el cierre del lote: «Aceptar N packs»
crea la reserva con su código; «Rechazar oferta» o dejarla vencer termina la espera, y volver
exige unirse de nuevo. «Salir de la lista de espera» deja el lugar.

### Vencimientos

Al terminar la ventana de retiro, las reservas sin retirar pasan a «Vencida» y las esperas y
ofertas pendientes terminan; el lote deja de aparecer en «Explorar lotes». El estado se muestra
vencido aunque el registro automático todavía no haya ocurrido.

### Avisos

«Avisos» reúne ofertas, reservas confirmadas o canceladas, ofertas vencidas, mensajes del chat
e incidencias, con un contador de no leídos en el menú. Se actualiza cada 15 segundos con la
pestaña visible y al reconectar. Cada aviso enlaza a lo que corresponde («Ver oferta», «Ver
reserva», «Abrir conversación», «Ver incidencia»). «Marcar como leído» solo registra la lectura.

### Chat de la reserva

«Chat de la reserva», en el detalle de una reserva, conversa con el establecimiento. Los
mensajes nuevos aparecen cada 5 segundos y un envío sin confirmar se puede reintentar sin
duplicarse. Cuando la reserva se cancela, vence o se retira, la conversación queda en solo
lectura: «Conversación cerrada».

### Reportar un problema e incidencias recibidas

«Reportar un problema», en el detalle de una reserva o de una espera, envía al establecimiento
lo que se encontró, hasta 2000 caracteres. El reporte no cancela la reserva ni la espera, y
nadie recibe avisos hasta que el establecimiento publica una versión. Cuando la publica, llega un
«Aviso de incidencia» con el motivo y las instrucciones, también a quien ya retiró sus packs.
«Historial de incidencias» conserva todas las versiones recibidas aunque el lote cierre;
marcarlas como leídas no indica que se cumplieron las instrucciones.

## Para el operador

### Publicar un lote

«Publicar lote» abre el formulario: establecimiento, descripción del pack, categoría,
cantidad de packs, condiciones de retiro, dirección, latitud y longitud, zona horaria e inicio
y cierre del retiro. «Guardar borrador» lo guarda sin publicar. Con el borrador guardado se
agregan fotos JPEG, PNG o WebP de hasta 5 MiB («Agregar foto»), hasta el cupo que indica la
página (tres por defecto); cada una pasa por «En validación» antes de quedar lista. Se puede
publicar sin fotos. «Publicar lote» pide «Confirmar publicación». Publicado, el lote no se
edita: cantidad, contenido, lugar, plazo y fotos quedan fijos.

### Gestionar disponibilidad

En el lote publicado, «Gestionar disponibilidad» ofrece tres acciones con motivo:

- «Descontar venta en el local o merma» resta packs libres; no toca los reservados.
- «Pausar publicación» oculta el lote y suspende reservas y ofertas nuevas, sin perder las
  existentes; «Reactivar publicación» lo vuelve a ofrecer.
- «Retirar publicación definitivamente» cancela las reservas pendientes, invalida sus códigos
  y termina la espera. Conserva las entregas y no se puede deshacer.

### Validar retiros

«Validar retiros», desde «Mis lotes», el lote o el panel, recibe el código que muestra la
persona. «Revisar código» indica cantidad y estado sin datos de la persona; si está vigente,
«Confirmar retiro de N packs» registra la entrega. Solo se confirma dentro de la ventana de
retiro. Cinco códigos incorrectos en quince minutos suspenden la revisión por quince minutos.

### Mi establecimiento

El panel muestra, para el establecimiento elegido:

- **Ahora:** lotes abiertos con su inventario (libres, ofrecidos, reservados, retirados y no
  asignables), reservas por retirar, ofertas por aceptar y personas en espera.
- **Incidencias por revisar:** reportes que aún no se publican.
- **Resultados del período:** lotes cerrados entre dos fechas (por defecto, los últimos 7
  días), packs retirados sobre publicados y reservas vencidas sobre confirmadas.
- **Compromisos e Historial:** reservas y esperas, «Vigentes» o «Terminados», y los hechos de
  cada lote, sin nombres ni códigos.

«Actualizar» vuelve a consultar todo. Desde los compromisos se abre el chat de cada reserva.

### Incidencias

«Incidencias», desde «Mis lotes», el lote o el panel, reúne los reportes del lote. Ahí también
se reporta un problema. Cada reporte queda «Por revisar» hasta que el operador publica una
versión con motivo e instrucciones; publicar avisa a quienes tuvieron reserva o espera en el
lote, a quienes retiraron y a los operadores. Después se puede «Publicar actualización» o
«Resolver incidencia»; resuelta, no admite más versiones. «Cerrar el lote con esta versión» es
una decisión aparte que pide confirmar: cancela reservas pendientes, invalida códigos y conserva
las entregas. Cada versión muestra quién la publicó, cuándo y sus avisos pendientes, generados
y leídos. «Ver todas las incidencias» lista las del establecimiento por estado.

## Si algo falla

| Situación | Lo que muestra la aplicación | Qué hacer |
| --- | --- | --- |
| Sesión vencida | «Tu sesión venció. Inicia sesión nuevamente.» | Iniciar sesión; se vuelve a la página. |
| Solicitud rechazada | «La solicitud fue rechazada por seguridad. Recarga la página…» o «Acceso denegado: tu cuenta no opera…» | Recargar; si persiste, la cuenta no tiene ese permiso. |
| No existe o no es propio | «El lote no existe o dejó de estar disponible.», «La reserva no existe o no pertenece a tu cuenta.» | Volver a la lista correspondiente. |
| El estado cambió | «No hay packs suficientes o ya tienes una reserva activa…», «El estado cambió y esta acción ya no está disponible…», «La incidencia cambió…» | «Actualizar» y decidir con el estado vigente. |
| Datos inválidos | El campo indicado con su error, por ejemplo «Revisa la cantidad solicitada.» | Corregir y reenviar. |
| Demasiadas solicitudes | «Hay demasiadas solicitudes. Espera…» o, al validar códigos, «Hay demasiados intentos. Espera N s…» | Esperar el tiempo indicado. |
| Sin conexión | «No fue posible conectar con el servicio. Revisa tu conexión…» | Reintentar al reconectar; avisos y chat se recuperan solos. |
| Respuesta perdida | «No pudimos confirmar si tu reserva quedó hecha…», «Comprobar si quedé en la lista», «Reintentar la misma operación» | Comprobar o reintentar: se repite la misma intención y no se duplica. |
| Oferta vencida | «Se acabó el plazo de esta espera y ya no puedes aceptar ofertas…» | Volver al lote y unirse de nuevo. |
| Conversación cerrada | «Conversación cerrada. Puedes leer el historial, pero ya no escribir.» | Usar «Reportar un problema» si hace falta. |

## Lo que la aplicación no hace

- No recupera contraseñas: una cuenta sin contraseña se reemplaza por otra.
- No crea establecimientos ni habilita operadores desde la aplicación.
- No precarga coordenadas ni las elige en un mapa ([#97](https://github.com/ClemoAcevedo/rescate/issues/97)).
- No acredita consumo ni kilos: «retirado» es una entrega registrada por el operador.

## Correspondencia con los requisitos

| Requisito | Sección |
| --- | --- |
| RF01 cuentas y establecimientos | [Cuenta y acceso](#cuenta-y-acceso) |
| RF02 publicación | [Publicar un lote](#publicar-un-lote) y [Gestionar disponibilidad](#gestionar-disponibilidad) |
| RF03 descubrimiento | [Explorar lotes](#explorar-lotes) |
| RF04 compromiso | [Reservar](#reservar) |
| RF05 cancelación | [Cancelar](#cancelar) |
| RF06 retiro | [Ver el código y retirar](#ver-el-código-y-retirar) y [Validar retiros](#validar-retiros) |
| RF07 espera y oferta | [Lista de espera y ofertas](#lista-de-espera-y-ofertas) |
| RF08 vencimiento | [Vencimientos](#vencimientos) |
| RF09 avisos | [Avisos](#avisos) |
| RF10 panel | [Mi establecimiento](#mi-establecimiento) |
| RF11 incidencias | [Reportar un problema](#reportar-un-problema-e-incidencias-recibidas) e [Incidencias](#incidencias) |
| RF12 métricas | [Mi establecimiento](#mi-establecimiento), resultados del período |
| RF13 chat | [Chat de la reserva](#chat-de-la-reserva) |

Las reglas detalladas de cada área están en el [índice de documentación](README.md).
