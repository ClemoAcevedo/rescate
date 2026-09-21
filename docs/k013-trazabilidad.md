# K013 — Trazabilidad y decisiones pendientes E2

## Fuentes y prioridad

La fuente funcional base son el [informe E1](entregas/e1/informe-e1.pdf) y los
[anexos E1](entregas/e1/anexos-e1.pdf). [ADR 0002](adr/0002-ofertas-parciales.md)
es una decisión posterior y vigente, pero modifica sólo oferta parcial y salida de
la cola. [OpenAPI S02](api/README.md) prevalece para el transporte de K008–K011;
no define por sí solo el dominio ni los RF posteriores. El
[modelo inicial](modelo-inicial.md) y [K010](k010-publicacion-lotes.md) distinguen
lo persistido/implementado de este objetivo; [K005](k005-fotos.md) acredita sólo
un prototipo de almacenamiento de objetos.

El código se usó para comprobar el estado implementado: K010 tiene reglas y casos
de uso de borrador/publicación, y no hay modelos, puertos, rutas ni migraciones de
fotos asociadas, compromisos completos, códigos, entregas o incidencias. No se usa
el código como sustituto de los requisitos E1.

## Matriz de trazabilidad

| RF o tema | Fuente original y lectura vigente | Entidades y permisos | Reglas/estados | Caso de uso | Cobertura actual |
| --- | --- | --- | --- | --- | --- |
| RF01 — cuentas y establecimientos | Anexos A p. 1, B p. 4 y H p. 21. Una persona puede operar establecimientos mediante membresía; registro no implica pertenencia. | Usuario, Establecimiento, Membresía; operador = usuario miembro. | Autorización contextual, no por ID público. | Transversal a todos; CU-RF02-01. | `users`/`establishments`/`memberships` existen; sesión y gestión de membresías pendientes. |
| RF02 — publicación | Anexos A p. 1, B p. 4, C p. 5 y H p. 20; K010 concreta transporte. | Lote, Establecimiento, operador miembro. | Borrador → Publicado; versión, ventana válida e inmutabilidad posterior. | CU-RF02-01. | Implementado sólo para declaración sin fotos asociadas. |
| Fotos de lote | Anexo I p. 25: opcionales, hasta tres, acceso autorizado y fijas al publicar. | Foto de lote pertenece a un lote; operador gestiona antes de publicar; consulta según visibilidad. | Sólo fotos listas pueden ser visibles; cero fotos permite publicación. | CU-RF02-01, CU-RF03-01. | K005 es prototipo aislado; asociación, validación y contrato pendientes. |
| RF03 — descubrimiento | RF03 citado por OpenAPI S02 y modelo; K010 no es detalle público. | Lote publicado y persona que explora; política de sesión pendiente. | Consulta no altera `Q` ni disponibilidad. | CU-RF03-01. | Pendiente. |
| RF04 — compromiso | Anexos A p. 1, B p. 4 y F p. 8; ADR 0002 precisa cantidades. | Compromiso: usuario, lote, solicitud/oferta/reserva. | Cantidades solicitada, ofrecida y confirmada distintas; packs enteros/indivisibles; una reserva activa por usuario/lote requiere compatibilidad al reingresar. | CU-RF04-01. | Sólo `commitments.confirmed` persistido; sin flujo completo. |
| RF05 — cancelación | Anexos A p. 1 y ADR 0002 para el efecto sobre cantidad aceptada. | Reserva confirmada y usuario titular. | Confirmada → Cancelada sin duplicar liberación; destino de `R` condicionado a reglas de RF05. | CU-RF05-01. | Pendiente. |
| RF06/RF10 — retiro y panel | Informe E1 p. 5; ADR 0002 confirma acreditar packs realmente retirados, no demanda descartada. | Reserva, Entrega, usuario titular y operador miembro. | Confirmada → Entregada; registro de entrega y `R → E`. | CU-RF06-01. | Pendiente. |
| Código de retiro | Anexos E1 A p. 2 y G pp. 13 y 16: titular consulta código; operador autorizado lo revisa y confirma entrega completa; código aleatorio de ocho caracteres y cinco fallos/operador/15 min. | Código como credencial asociada a reserva confirmada; espera sin código. | Vigente → Usado al acreditar; revisar no consume; un reintento no crea otra entrega. | CU-RF06-01. | Requisito definido, implementación pendiente. |
| RF07 — FIFO y oferta | Anexos A p. 2/B p. 4 y ADR 0002. | Solicitud, Oferta, Reserva; asignador y usuario solicitante. | Cabeza FIFO; `F → O → R`; parcial sólo a la cabeza; cerrar sin prioridad residual. | CU-RF07-01. | Pendiente. |
| RF08 — vencimiento | Anexos A p. 2 y H pp. 20, 23; ADR 0002 extiende desenlace a parcial. | Oferta, Reserva, Lote; regla temporal compartida. | Oferta vencida cierra y libera una vez; sin prórroga por desconexión. | CU-RF07-01; transversal a CU-RF05-01/CU-RF06-01. | Pendiente; worker inactivo. |
| RF09 — avisos | Informe E1 p. 5 y ADR 0002. | Oferta/compromiso y destinatario. | Aviso comunica oferta/vencimiento; no cambia la prioridad ni sustituye la comprobación temporal. | CU-RF07-01. | Pendiente. |
| Incidencia posterior — RF por identificar | E1 es citado en el modelo inicial como alcance posterior; no se pudo corroborar el número RF en fuentes textuales disponibles. | Incidencia ligada a Entrega, reportante y contexto de establecimiento. | Reportada → En atención → Resuelta; no revierte entrega por sí misma. | CU-INC-01, CU-INC-02. | Pendiente; D-01 y D-03 bloquean su detalle final. |
| RF12 — métricas | Informe E1 p. 5 y ADR 0002. | Lote, reserva y entrega. | Sólo `E` acredita rescate; demanda cerrada o rechazada no cuenta como entrega. | Resultado de CU-RF06-01; no agrega caso de métricas sin requisito detallado. | Pendiente. |

## Recorridos revisados

| Recorrido | Coherencia comprobada | Límite visible |
| --- | --- | --- |
| Publicar con fotos, reservar y acreditar | CU-RF02-01 fija la declaración/fotos; CU-RF04-01 y CU-RF07-01 separan solicitud, oferta y reserva; CU-RF06-01 crea una entrega única `R → E`. | La carga/validación de fotos y la implementación del código están pendientes; publicar con cero fotos continúa válido. |
| Código inválido, fuera de ventana o usado | El modelo no altera reserva, entrega ni inventario por un código que no valide; uno usado nunca crea segunda entrega. | El código se consume al acreditar; no se define rotación ni vencimiento independiente de la reserva. |
| Reportar y resolver incidencia después de entrega | CU-INC-01 requiere entrega acreditada y CU-INC-02 preserva su historial; la incidencia tiene su propio ciclo. | Falta identificar el RF y decidir reportante, resolutor, desenlaces y efectos comerciales. |
| Operación sin permiso | Membresía contextual protege gestión de lote, acreditación y acceso operativo; usuario sólo actúa sobre sus compromisos/entregas. | Faltan sesión integrada, política de descubrimiento y administración/revocación de membresías. |

No se detectó una contradicción documental entre el modelo, estados y casos de uso
para las reglas confirmadas. Las ambigüedades no se resolvieron por inferencia: se
registran a continuación y mantienen los flujos afectados como objetivo, no como
funcionalidad completa.

## Revisión de D-01 a D-03

### D-01 — Identificador y alcance de incidencias

**Pregunta concreta.** ¿Qué RF identifica el reporte/resolución de incidencias y
qué comportamiento de negocio exige?

**Origen.** Esta duda se introdujo en la fila «Incidencia posterior» de la matriz
anterior, en la entidad Incidencia de
[modelo-inicial.md](modelo-inicial.md#entidades-responsabilidades-y-relaciones) y
en CU-INC-01/02 de [casos-de-uso.md](casos-de-uso.md). Las fuentes previas sólo
las enumeran como trabajo posterior: «…códigos, retiro, FIFO, ofertas,
vencimientos, chat, avisos, **incidencias**, auditoría y retención»
([modelo-inicial.md](modelo-inicial.md#fuera-de-k003)); API S02 dice que se
«posponen … chat, **incidencias**, worker y estadísticas»
([api/README.md](api/README.md#tipos-implementación-futura-y-e2)). Anexos E1 H p.
20 menciona claves de idempotencia para asignación/incidencias, pero no proporciona
en las fuentes revisadas un RF numerado ni un flujo de atención.

**Clasificación.** Información no encontrada. No hay contradicción entre fuentes
vigentes ni diferencia requisito/implementación que permita deducir el RF.

**Efecto sobre K013.** Puede permanecer abierto sin contradecir el modelo: el caso
se mantiene como objetivo posterior y no atribuye reglas inexistentes. Impide
cerrar la trazabilidad exhaustiva de incidencias, no la coherencia de usuarios,
lotes, compromisos y entrega.

### D-02 — Código de retiro

**Pregunta concreta original.** ¿El retiro usa código y cuál es su ciclo?

**Resultado.** Resuelta; se elimina D-02 de la lista de pendientes. Anexos E1 A
p. 2 establece: «El titular consulta cantidad, estado, lugar, plazo y código» y
que «el operador autorizado revisa el código y confirma la entrega completa dentro
de la ventana». También aclara que revisarlo no acredita por sí solo el retiro.
Anexos G p. 13 lo llama «credencial de retiro» y prohíbe ponerlo en rutas,
historial de navegación o registros de acceso; G p. 16 fija código aleatorio de
ocho caracteres y cinco fallos por operador cada quince minutos.

**Clasificación.** Diferencia entre requisito y documentación K013 anterior: la
ausencia de operaciones en código/OpenAPI no invalidaba un requisito ya definido
en E1. Se corrigieron modelo, estados, caso CU-RF06-01 y matriz.

**Efecto sobre K013.** Ya no impide el criterio: código, entrega y sus efectos se
describen sin contradicción. Su implementación queda fuera de esta tarjeta.

### D-03 — Atención y resolución de incidencias

**Pregunta concreta.** ¿Quién puede reportar, atender y resolver una incidencia,
y qué desenlaces comerciales puede producir?

**Origen.** El modelo atribuía estas incógnitas a D-03 en
[modelo-inicial.md](modelo-inicial.md#entidades-responsabilidades-y-relaciones) y
CU-INC-01/02 evita fijar un resolutor. Las mismas fuentes citadas para D-01 sólo
nombran incidencias o sus claves idempotentes; no identifican reportante, rol
resolutor, reapertura, compensación, sanción ni ajuste de inventario.

**Clasificación.** Información no encontrada y decisión de diseño todavía no
acordada. No es contradicción: las alternativas son (a) atención por operador del
establecimiento, que exige resolver conflictos de interés; (b) un rol de operación
separado, que exige administración y autorización nueva; o (c) un flujo entre
participantes, que requiere estados de disputa/confirmación. Se recomienda no
registrar ninguna como acuerdo hasta que Producto/Operación la seleccione.

**Efecto sobre K013.** No contradice los requisitos ni la regla de que la
incidencia no revierte automáticamente una entrega. Sí impide declarar completos
los permisos y los desenlaces del subdominio de incidencias; por tanto, el
criterio sólo puede cerrarse como completo para incidencias tras resolver esta
pregunta.

## Decisiones pendientes

| ID | Pregunta concreta | Fuente de la duda | Elementos afectados | Rol que debe resolver |
| --- | --- | --- | --- | --- |
| D-01 | ¿Qué identificador RF y qué alcance exacto tiene el reporte y la resolución de incidencias posteriores? | E1 las menciona como alcance posterior y H p. 20 las nombra junto a las claves, pero no hay RF ni flujo de atención identificable. | Incidencia, CU-INC-01, CU-INC-02, trazabilidad. | Producto/propietario de requisitos. |
| D-03 | ¿Quién puede reportar, atender y resolver una incidencia, y qué desenlaces comerciales puede producir? | Las fuentes sólo nombran incidencias o sus claves; no atribuyen rol, compensación, sanción ni ajuste. | Incidencia, permisos, estados, CU-INC-01/02. | Producto/operación. |
| D-04 | ¿Puede un usuario crear una solicitud nueva sobre un lote cuando aún tiene una reserva confirmada activa? | K003 protege una reserva activa por usuario/lote; ADR 0002 exige reingreso explícito pero deja esta compatibilidad como riesgo futuro. | Compromiso, RF04, FIFO, índice activo. | Producto y dominio. |
| D-05 | Cuando existe una foto de lote no lista/no autorizada, ¿se bloquea la publicación completa o se omite sólo esa foto? | Anexo I p. 25 exige fotos opcionales y fijas; OpenAPI/K010 sólo exige cero fotos válido. | Foto de lote, publicación, consulta, K014. | Producto y seguridad. |
| D-06 | Al retirar un lote o al vencer/cancelar una reserva, ¿qué transiciones exactas aplican a `R`, ofertas activas y solicitudes en espera? | RF02 exige retirar para corregir; ADR 0002 define oferta parcial pero remite el recorrido de reserva a reglas existentes no materializadas. | Lote, compromiso, inventario, CU-RF05-01. | Producto y dominio. |
| D-07 | ¿RF03 permite descubrimiento sin sesión y qué información/fotos puede ver cada actor? | OpenAPI aclara que su GET actual es sólo de operador y no implementa descubrimiento RF03. | Consulta de lote, fotos, autorización, CU-RF03-01. | Producto y seguridad. |
| D-08 | ¿Qué clave de idempotencia, retención de resultado y respuesta de reintento se aplican a asignación, acreditación e incidencias? | Anexos H p. 20 exige claves para asignación/incidencias; no fija su representación en el dominio ni el contrato HTTP. | Oferta, entrega, incidencia y concurrencia. | Dominio y arquitectura. |

## Verificación documental

Se revisaron los enlaces relativos añadidos contra los archivos existentes y se
ejecutó `git diff --check` para los cuatro cambios documentales. Los diagramas
Mermaid se conservaron como fuente editable en `modelo-inicial.md`; el repositorio
no incluye un renderizador Mermaid, por lo que no se declara un renderizado.
