# Casos de uso de dominio

Este catálogo se incorpora en K013 porque el repositorio no tenía casos de uso
editables anteriores. Describe comportamiento de negocio; no es una lista de
pantallas, endpoints ni evidencia de implementación. El modelo y las máquinas de
estado que usa están en [modelo-inicial.md](modelo-inicial.md#modelo-conceptual-e2-k013).

## Fuentes y alcance

Los identificadores RF se conservan cuando están identificados en los documentos
vigentes: RF02 (lotes), RF03 (descubrimiento), RF04 (compromiso), RF05
(cancelación), RF06/RF10 (retiro y panel), RF07/RF08 (FIFO y vencimientos) y
RF11 (incidencias). Se usan el [informe E1](entregas/e1/informe-e1.pdf), pp. 1–3
y 5, los [anexos E1](entregas/e1/anexos-e1.pdf), A pp. 1–3, B p. 4, C p. 5,
E p. 7, F p. 8, H pp. 20–21 e I pp. 24–27, y [ADR 0002](adr/0002-ofertas-parciales.md).

Las incidencias corresponden a RF11 (anexos A p. 3, «RF11 · Incidencias») y su
alcance está en el anexo I p. 26: cualquier problema descubierto sobre un lote,
antes o después de entregar. Esto resuelve D-01 y D-03 de
[K013](k013-trazabilidad.md#revisión-de-d-01-a-d-03). K010 implementa sólo la
parte de creación, consulta de operador, edición y publicación de lotes; K005 es
un prototipo de objetos aislado. Las operaciones restantes son objetivo de dominio.

## CU-RF02-01 — Publicar lote con fotos

**Objetivo.** Dejar disponible un lote declarado por un operador y fijar su
contenido descriptivo, incluidas las fotos opcionales que estén listas.

**Actores y permisos.** Un usuario con membresía del establecimiento es el
operador. Nadie obtiene este permiso por registrarse ni por conocer un ID público.

**Precondiciones.** El lote pertenece al establecimiento operado, está en
Borrador, su declaración es válida, la ventana aún no finaliza y la versión sigue
vigente. Si hay fotos, pertenecen al lote y están listas para ser visibles. Cero
fotos es válido.

**Flujo principal.**

1. El operador revisa la declaración y las fotos asociadas.
2. El sistema autentica al actor, verifica su membresía y bloquea/relee el lote.
3. Valida versión, estado, declaración y ventana; comprueba las asociaciones de
   fotos sin hacer llamadas externas bajo el bloqueo.
4. Publica el lote, registra el instante y deja fijos cantidad, contenido, lugar,
   plazo y conjunto de fotos.
5. Devuelve la representación autorizada del lote publicado.

**Alternativos y errores.** Sin sesión o membresía se rechaza; lote inexistente se
trata como tal; versión obsoleta, lote publicado o ventana terminada producen
conflicto/regla inválida sin mutación. Una foto en carga, en validación o rechazada
impide publicar hasta que termine o se quite ([ADR 0005](adr/0005-ciclo-de-fotos.md)).
No se carga ni procesa una imagen dentro de este caso; ver [fotos](fotos.md).

**Postcondiciones.** Estado Publicado, o ningún cambio ante error. El lote sólo
será asignable después si además tiene `F > 0`; publicar no crea compromisos.

## CU-RF03-01 — Consultar lote publicado con fotos

**Objetivo.** Permitir descubrir y consultar la información de un lote publicado
que sea visible para quien rescata, sin exponer claves de almacenamiento ni datos
de otros compromisos.

**Actores y permisos.** Cualquier persona, también sin sesión: «el visitante
explora sin sesión» (anexos A p. 1). El operador consulta además sus propios
lotes, incluidos borradores, mediante la operación de [lotes](lotes.md).

**Precondiciones.** El lote está Publicado y no Retirado ni Vencido.

**Búsqueda (A p. 1, G p. 11).** Lista paginada filtrable por ubicación, categoría
y ventana de retiro. La zona puede elegirse a mano y la distancia es geográfica y
aproximada, no un tiempo de viaje. Negar la geolocalización no impide explorar.
El detalle muestra pack, cantidad, lugar y plazo antes de solicitar (G p. 12).

**Flujo principal.**

1. La persona solicita un lote o resultado de descubrimiento.
2. El sistema comprueba la visibilidad, estado y vigencia que aplique.
3. Devuelve declaración, ventana y sólo fotos asociadas listas/autorizadas.
4. Muestra disponibilidad como condición derivada, nunca como sinónimo de `Q`.

**Alternativos y errores.** Lote no visible, retirado o inexistente no revela
información adicional. Solo se muestran fotos listas; si falta o falla, la web
muestra una imagen de reemplazo (I p. 25, G p. 11). Abrir un lote no reserva
packs: el servidor vuelve a comprobar la disponibilidad al solicitar.

**Postcondiciones.** No cambia lote, inventario, fotos ni membresías.

## CU-RF04-01 — Crear y consultar un compromiso

**Objetivo.** Registrar la solicitud de packs de un usuario y permitir que las
partes autorizadas consulten su avance, distinguiendo cantidad solicitada,
ofrecida y confirmada.

**Actores y permisos.** Usuario que rescata crea y consulta sus compromisos. El
operador del establecimiento consulta los necesarios para preparar el retiro; no
puede crear una solicitud en nombre de otro usuario sin una regla expresa.

**Precondiciones.** Usuario autenticado, lote publicado antes de su cierre,
cantidad entera positiva de packs indivisibles y ningún otro compromiso activo
del usuario sobre ese lote: «se admite un compromiso activo por usuario y lote»
(A p. 1). La nueva solicitud que permite ADR 0002 tras aceptar una oferta parcial
queda sujeta a esta regla. El máximo es la disponibilidad asignable, sin un tope
fijo por persona.

**Flujo principal.**

1. El usuario solicita una cantidad del lote.
2. El sistema relee lote, disponibilidad y restricciones de compromiso en una
   unidad atómica.
3. **Reserva directa** (B p. 4): si hay `F` suficiente, nadie espera antes
   (prioridad atendida) y el lote no ha cerrado, confirma la reserva y mueve la
   cantidad `F → R`.
4. Si no alcanza, la persona puede entrar voluntariamente a la espera (A p. 2):
   se registra la cantidad solicitada y una posición FIFO, y la confirmación solo
   llega mediante una oferta (CU-RF07-01).
5. Al consultar, el sistema muestra a cada actor sólo el compromiso al que tiene
   acceso y las cantidades que le correspondan.

**Alternativos y errores.** Lote no vigente, cantidad inválida, usuario sin sesión
o compromiso activo existente no cambian inventario. Ante dos solicitudes por el
último pack solo una se confirma. Repetir la operación con la misma clave devuelve
el compromiso existente sin crear otro (A p. 1, H p. 21). El reingreso después de
rechazo o vencimiento de una oferta requiere una nueva acción y posición.

**Postcondiciones.** Existe una reserva Confirmada directa, una solicitud En
espera o, tras aceptar una oferta, una reserva Confirmada por exactamente la
cantidad aceptada. K003 solo persiste reservas confirmadas.

## CU-RF07-01 — Ofertar y resolver compromiso FIFO

**Objetivo.** Ofrecer packs a la primera solicitud elegible y resolver la oferta
sin perder FIFO ni crear prioridad residual.

**Actores y permisos.** El asignador del sistema ejecuta la oferta con el contexto
autorizado del establecimiento; el usuario solicitante acepta o rechaza. La regla
temporal procesa vencimientos con la misma política.

**Precondiciones.** Lote vigente; primera solicitud elegible identificada bajo
bloqueo; cantidad libre `F`; no existe desenlace previo de esa oferta.

**Flujo principal.**

1. El sistema bloquea y relee lote, contadores, tiempo y cabeza FIFO.
2. Retiene una cantidad ofrecida desde `F` a `O`. Puede ser menor que la pedida,
   pero sólo para la cabeza, conforme a ADR 0002.
3. Comunica la oferta y su vigencia al usuario.
4. Si el usuario acepta mientras está vigente, mueve sólo esa cantidad `O → R`,
   confirma la reserva y cierra la solicitud.

**Alternativos y errores.** Si no hay cantidad libre o el lote no está vigente no
se oferta ni se adelanta una solicitud posterior. Rechazar o vencer libera sólo lo
retenido a `F` o `X` según vigencia, cierra la solicitud y no crea reingreso. Un
reintento de aceptación/rechazo/vencimiento no duplica reserva ni liberación. El
plazo concreto de la oferta es el definido por E1; no se agrega otro.

**Postcondiciones.** Oferta activa o solicitud cerrada. Aceptar una parcial deja
una reserva por la cantidad ofrecida, no una demanda residual; volver a pedir exige
un compromiso nuevo y una posición FIFO nueva.

## CU-RF05-01 — Cancelar reserva confirmada

**Objetivo.** Terminar una reserva confirmada cuando procede, sin confundirla con
el cierre previo de la solicitud FIFO.

**Actores y permisos.** Usuario titular de la reserva; cualquier facultad del
operador o del sistema necesita una regla explícita adicional.

**Precondiciones.** Reserva Confirmada, no entregada y dentro de las condiciones
de cancelación de RF05.

**Flujo principal.** El sistema autoriza al titular, relee y bloquea la reserva,
verifica que siga cancelable, cambia su estado a Cancelada y aplica la conciliación
de inventario que corresponda.

**Alternativos y errores.** Una reserva entregada, vencida, ajena o ya cancelada
no se vuelve a cancelar ni libera packs dos veces. El plazo de cancelación y el
destino preciso de `R` no se fijan aquí porque deben confirmarse contra RF05.

**Postcondiciones.** Reserva Cancelada o ningún cambio. No se recrea una solicitud
FIFO ni se modifica una entrega histórica.

## CU-RF06-01 — Acceder al código y acreditar entrega

**Objetivo.** Permitir el retiro completo de packs confirmados mediante el código
de retiro y registrar una única entrega acreditada.

**Actores y permisos.** El usuario titular consulta la información de retiro. Un
operador del establecimiento acredita la entrega. Un código no equivale por sí
solo a una identidad ni a autorización de operador.

**Precondiciones.** Reserva Confirmada y vigente; operador con membresía del
establecimiento; código aleatorio de ocho caracteres asociado a la reserva y no
consumido. La solicitud En espera no tiene código.

**Flujo principal.**

1. El usuario consulta cantidad, estado, lugar, plazo y código de su reserva.
2. El operador inicia la acreditación y el sistema bloquea/relee reserva, lote y
   entrega previa.
3. Revisa actor, estado y código; esta revisión sola no acredita el retiro.
4. Confirma el retiro completo, crea el registro de Entrega, consume el código y mueve la
   cantidad confirmada `R → E` en la misma unidad atómica.

**Alternativos y errores.** Código inválido, de otra reserva o usado no crea
entrega ni modifica inventario. Cinco fallos por operador en quince minutos activan
el límite definido, junto al límite por origen de H. Repetir una confirmación usada
no puede crear una segunda entrega. Una reserva cancelada/vencida/entregada se
rechaza. El código no se muestra en URL, historial ni logs.

**Postcondiciones.** Una Entrega registrada y reserva Entregada, o ningún cambio.
La posterior apertura de una incidencia no invierte estos hechos.

## CU-RF11-01 — Reportar incidencia de un lote

**Objetivo.** Registrar un problema descubierto sobre un lote, antes o después de
entregar (vencimiento del alimento, contenido incorrecto u otra situación), para
que el establecimiento lo revise.

**Actores y permisos.** Cualquier usuario puede reportar sobre objetos a los que
tenga acceso (anexo I p. 26): quien tiene o tuvo un compromiso con el lote, o un
operador miembro de su establecimiento.

**Precondiciones.** Lote existente y reportante con acceso. No se exige entrega
previa ni lote abierto; E1 no fija una ventana máxima de reporte.

**Flujo principal.** El reportante describe el problema (motivo de hasta 2000
caracteres, anexo H p. 20) y el sistema registra la incidencia asociada al lote,
con autor y fecha, pendiente de revisión.

**Alternativos y errores.** Lote inexistente o sin acceso, o datos inválidos, no
crean la incidencia. El reporte no cancela compromisos, no cierra el lote ni envía
una alerta general de forma automática.

**Postcondiciones.** Incidencia registrada y pendiente de revisión; lote,
compromisos y entregas sin cambios.

## CU-RF11-02 — Publicar incidencia y avisar a los vinculados

**Objetivo.** Comunicar una incidencia revisada a todas las personas vinculadas
al lote, con motivo e instrucciones.

**Actores y permisos.** Un operador miembro del establecimiento del lote o
administración (anexo I p. 26; anexo E p. 7). Publicar es una decisión explícita.

**Precondiciones.** Incidencia existente sobre un lote del establecimiento.

**Flujo principal.** El operador fija motivo e instrucciones y publica. Bajo
bloqueo del lote y en una transacción se persisten incidencia, versión, evento y
destinatarios: todas las personas con compromisos históricos del lote (en espera,
con oferta, con reserva activa, canceladas, vencidas o retiradas) y sus operadores
autorizados, deduplicados por persona. Si el lote sigue abierto, un compromiso
creado después se incorpora a los avisos vigentes bajo el mismo bloqueo. El
worker genera los avisos en la bandeja por tandas recuperables.

**Alternativos y errores.** Actor sin membresía o incidencia de otro
establecimiento se rechazan sin exponer datos. Una restricción única por
incidencia, versión y usuario impide avisos duplicados, incluso con reintentos o
con una reserva concurrente. Estar desconectado no elimina el aviso ni implica
haberlo leído.

**Postcondiciones.** Incidencia abierta con una versión publicada; cada
destinatario tiene exactamente un aviso por versión. El texto distingue si la
persona recibió packs o solo tuvo un compromiso, y no revela identidades de otros.

## CU-RF11-03 — Dar seguimiento, resolver o cerrar el lote por incidencia

**Objetivo.** Registrar la evolución de una incidencia publicada y, si se decide,
cerrar el lote sin alterar entregas previas.

**Actores y permisos.** Operador miembro del establecimiento del lote o
administración. Cerrar el lote es una decisión explícita y separada de publicar.

**Precondiciones.** Incidencia publicada en estado abierta o en seguimiento.

**Flujo principal.** Una actualización relevante pasa la incidencia a en
seguimiento; la resolución la deja resuelta. Cada una publica una nueva versión
con aviso a los destinatarios históricos y actuales. El panel distingue avisos
pendientes, generados y leídos.

**Cierre por incidencia.** Si se decide cerrar el lote, el mismo protocolo, bajo
bloqueo, cancela los compromisos pendientes, invalida sus códigos y mueve `F`, `O`
y `R` a `X`. Los packs entregados `E` permanecen entregados y se conserva quién
retiró, cuánto y cuándo. Cierre, cancelación y confirmación de retiro compiten
bajo el mismo bloqueo: si la entrega gana se conserva; si gana el cierre, el retiro
se rechaza.

**Alternativos y errores.** Actor sin permiso o incidencia ya resuelta no cambian
el caso. Resolver no reabre el lote ni rehabilita códigos. Leer un aviso no
demuestra haber seguido las instrucciones.

**Postcondiciones.** Incidencia en seguimiento o resuelta con su historial de
versiones; lote abierto o cerrado según la decisión explícita. E1 no define
reembolsos, sanciones ni reapertura, por lo que no se modelan.
