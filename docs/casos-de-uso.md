# Casos de uso de dominio

Este catálogo se incorpora en K013 porque el repositorio no tenía casos de uso
editables anteriores. Describe comportamiento de negocio; no es una lista de
pantallas, endpoints ni evidencia de implementación. El modelo y las máquinas de
estado que usa están en [modelo-inicial.md](modelo-inicial.md#modelo-conceptual-e2-k013).

## Fuentes y alcance

Los identificadores RF se conservan cuando están identificados en los documentos
vigentes: RF02 (lotes), RF03 (descubrimiento), RF04 (compromiso), RF05
(cancelación), RF06/RF10 (retiro y panel) y RF07/RF08 (FIFO y vencimientos). Se
usan el [informe E1](entregas/e1/informe-e1.pdf), pp. 1–3 y 5, los
[anexos E1](entregas/e1/anexos-e1.pdf), A pp. 1–2, B p. 4, C p. 5, F p. 8,
H pp. 20–21 e I pp. 24–27, y [ADR 0002](adr/0002-ofertas-parciales.md).

E1 y la documentación actual mencionan incidencias, pero las fuentes textuales
revisables no permiten asignarlas con certeza a un número RF. Por eso los casos
de incidencia mantienen `RF pendiente de identificar` hasta resolver D-01; no se
crea un identificador RF ficticio. K010 implementa sólo la parte de creación,
consulta de operador, edición y publicación de lotes; K005 es un prototipo de
objetos aislado. Las operaciones restantes son objetivo de dominio.

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
conflicto/regla inválida sin mutación. Una foto ausente, no lista o no autorizada
impide mostrarla; la política exacta de si bloquea toda publicación se debe decidir
en K014. No se carga ni procesa una imagen dentro de este caso.

**Postcondiciones.** Estado Publicado, o ningún cambio ante error. El lote sólo
será asignable después si además tiene `F > 0`; publicar no crea compromisos.

## CU-RF03-01 — Consultar lote publicado con fotos

**Objetivo.** Permitir descubrir y consultar la información de un lote publicado
que sea visible para quien rescata, sin exponer claves de almacenamiento ni datos
de otros compromisos.

**Actores y permisos.** Persona que explora según la regla de visibilidad de RF03;
el requisito de sesión todavía debe confirmarse para este recorrido. El operador
consulta además sus propios lotes mediante la operación K010 ya delimitada.

**Precondiciones.** El lote está Publicado, no Retirado/Vencido para el propósito
que se consulte y la persona cumple la política de visibilidad que corresponda.

**Flujo principal.**

1. La persona solicita un lote o resultado de descubrimiento.
2. El sistema comprueba la visibilidad, estado y vigencia que aplique.
3. Devuelve declaración, ventana y sólo fotos asociadas listas/autorizadas.
4. Muestra disponibilidad como condición derivada, nunca como sinónimo de `Q`.

**Alternativos y errores.** Lote no visible, retirado o inexistente no revela
información adicional. Una foto no lista se omite o bloquea la respuesta según la
decisión pendiente de K014. Esta consulta no reserva packs ni concede permiso de
operador.

**Postcondiciones.** No cambia lote, inventario, fotos ni membresías.

## CU-RF04-01 — Crear y consultar un compromiso

**Objetivo.** Registrar la solicitud de packs de un usuario y permitir que las
partes autorizadas consulten su avance, distinguiendo cantidad solicitada,
ofrecida y confirmada.

**Actores y permisos.** Usuario que rescata crea y consulta sus compromisos. El
operador del establecimiento consulta los necesarios para preparar el retiro; no
puede crear una solicitud en nombre de otro usuario sin una regla expresa.

**Precondiciones.** Usuario autenticado, lote publicado/vigente, cantidad entera
positiva de packs indivisibles y cumplimiento de la regla RF04 de compromiso
activo por usuario/lote. Antes de habilitar una nueva solicitud con una reserva
activa previa debe resolverse la compatibilidad señalada en el modelo.

**Flujo principal.**

1. El usuario solicita una cantidad del lote.
2. El sistema relee lote, disponibilidad y restricciones de compromiso en una
   unidad atómica.
3. Registra el compromiso en espera con cantidad solicitada y posición FIFO, o lo
   confirma únicamente a través de una oferta válida.
4. Al consultar, el sistema muestra a cada actor sólo el compromiso al que tiene
   acceso y las cantidades que le correspondan.

**Alternativos y errores.** Lote no vigente, cantidad inválida, usuario sin sesión
o compromiso activo incompatible no cambian inventario. Una solicitud no convierte
por sí sola `F` en `R`. La aceptación de una oferta se trata en CU-RF07-01 y el
reingreso después de rechazo/vencimiento requiere una nueva acción y posición.

**Postcondiciones.** Existe solicitud En espera o, tras aceptar una oferta,
reserva Confirmada por exactamente la cantidad aceptada. K003 sólo representa el
segundo caso; el caso completo no está implementado.

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

**Objetivo.** Permitir el retiro de packs confirmados y registrar una única entrega
acreditada, con o sin código según se resuelva D-02.

**Actores y permisos.** El usuario titular consulta la información de retiro. Un
operador del establecimiento acredita la entrega. Un código no equivale por sí
solo a una identidad ni a autorización de operador.

**Precondiciones.** Reserva Confirmada y vigente; operador con membresía del
establecimiento. Si Producto confirma un código de retiro, éste debe estar vigente
y no usado.

**Flujo principal.**

1. El usuario consulta su información de retiro, incluido el código si existe y
   tiene derecho a verlo.
2. El operador inicia la acreditación y el sistema bloquea/relee reserva, lote y
   entrega previa.
3. Valida actor, estado y, si aplica, código.
4. Crea el registro de Entrega, consume el código si corresponde y mueve la
   cantidad confirmada `R → E` en la misma unidad atómica.

**Alternativos y errores.** Código inválido, vencido, de otra reserva o usado no
crea entrega ni modifica inventario. Repetir un código usado no puede crear una
segunda entrega; queda pendiente si la respuesta devuelve el comprobante previo o
un rechazo. Una reserva cancelada/vencida/entregada se rechaza. No se inventan
intentos máximos ni bloqueo por intentos.

**Postcondiciones.** Una Entrega registrada y reserva Entregada, o ningún cambio.
La posterior apertura de una incidencia no invierte estos hechos.

## CU-INC-01 — Reportar incidencia posterior a la entrega

**Objetivo.** Registrar un problema posterior contra una entrega acreditada y
permitir su consulta contextual.

**Actores y permisos.** El reportante debe tener acceso a la entrega; E1 no
permite fijar todavía si sólo puede reportar quien rescató, si interviene el
operador ni si existe soporte externo.

**Precondiciones.** Entrega existente y acreditada; reportante autorizado. No se
establece ventana máxima de reporte.

**Flujo principal.** El reportante identifica la entrega, describe la incidencia y
el sistema crea el registro en estado Reportada, asociado a entrega, compromiso y
reportante. Las partes autorizadas pueden consultar el caso y su historial.

**Alternativos y errores.** Entrega inexistente o ajena, actor sin permiso o datos
inválidos no crean una incidencia. Abrirla no cancela la reserva, no reduce `E` y
no altera disponibilidad de forma automática.

**Postcondiciones.** Incidencia Reportada; entrega permanece acreditada.

## CU-INC-02 — Resolver incidencia posterior

**Objetivo.** Registrar la atención y desenlace de una incidencia sin inventar
consecuencias comerciales.

**Actores y permisos.** Rol resolutor pendiente de D-03. No se atribuye la
facultad a todo operador, a un administrador ni a soporte sin fuente expresa.

**Precondiciones.** Incidencia existente, acceso autorizado y estado Reportada o
En atención.

**Flujo principal.** El resolutor toma atención, deja las acciones o resultado
necesarios y marca la incidencia Resuelta. El sistema conserva el vínculo con la
entrega y el historial de atención.

**Alternativos y errores.** Incidencia ya resuelta, actor sin permiso o resultado
inválido no cambian el caso. No se borra la entrega ni se crea automáticamente un
reembolso, sanción, ajuste de inventario o nueva reserva.

**Postcondiciones.** Incidencia Resuelta; la entrega sigue acreditada. Las reglas
para reabrir, rechazar o escalar un caso se mantienen pendientes.
