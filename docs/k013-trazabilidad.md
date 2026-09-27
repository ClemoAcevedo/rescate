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
| RF01 — cuentas y establecimientos | Anexos A p. 1, B p. 4 y H p. 21. Una persona puede operar establecimientos mediante membresía; registro no implica pertenencia. | Usuario, Establecimiento, Membresía; operador = usuario miembro. | Autorización contextual, no por ID público. | Transversal a todos; CU-RF02-01. | K008 implementa registro, login, sesión y logout; K010 comprueba membresía actual. La gestión de membresías sigue pendiente. |
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
| RF11 — incidencias | Anexos A p. 3 («RF11 · Incidencias»), E p. 7 e I p. 26: cualquier problema sobre un lote, antes o después de entregar. | Incidencia ligada al lote, autor y destinatarios; cualquier usuario con acceso reporta; operador miembro o administración publica, resuelve y decide cerrar. | Reportada → Abierta → En seguimiento → Resuelta, con versiones; cierre por incidencia `F/O/R → X` sin tocar `E`. | CU-RF11-01, CU-RF11-02, CU-RF11-03. | Pendiente; S08 (K043–K046). |
| RF12 — métricas | Informe E1 p. 5 y ADR 0002. | Lote, reserva y entrega. | Sólo `E` acredita rescate; demanda cerrada o rechazada no cuenta como entrega. | Resultado de CU-RF06-01; no agrega caso de métricas sin requisito detallado. | Pendiente. |

## Recorridos revisados

| Recorrido | Coherencia comprobada | Límite visible |
| --- | --- | --- |
| Publicar con fotos, reservar y acreditar | CU-RF02-01 fija la declaración/fotos; CU-RF04-01 y CU-RF07-01 separan solicitud, oferta y reserva; CU-RF06-01 crea una entrega única `R → E`. | La carga/validación de fotos y la implementación del código están pendientes; publicar con cero fotos continúa válido. |
| Código inválido, fuera de ventana o usado | El modelo no altera reserva, entrega ni inventario por un código que no valide; uno usado nunca crea segunda entrega. | El código se consume al acreditar; no se define rotación ni vencimiento independiente de la reserva. |
| Reportar, publicar y resolver incidencia | CU-RF11-01 registra el reporte sin efectos; CU-RF11-02 fija destinatarios bajo bloqueo; CU-RF11-03 versiona la resolución y, si se decide, cierra el lote conservando entregas. | La idempotencia de incidencias sigue en D-08. |
| Operación sin permiso | Membresía contextual protege gestión de lote, acreditación y acceso operativo; usuario sólo actúa sobre sus compromisos/entregas. | K008 integra sesión y Actor con K010. Siguen pendientes los flujos de compromisos/entregas, la política de descubrimiento y la administración/revocación de membresías. |

No se detectó una contradicción documental entre el modelo, estados y casos de uso
para las reglas confirmadas. Las ambigüedades no se resolvieron por inferencia: se
registran a continuación y mantienen los flujos afectados como objetivo, no como
funcionalidad completa.

## Revisión de D-01 a D-03

### D-01 — Identificador y alcance de incidencias

**Pregunta concreta original.** ¿Qué RF identifica el reporte/resolución de
incidencias y qué comportamiento de negocio exige?

**Resultado.** Resuelta. Los anexos E1 A p. 3 enumeran «RF11 · Incidencias» y el
anexo I p. 26 («Incidencias y seguimiento posterior») define su alcance: «RF11
cubre cualquier problema descubierto sobre un lote, antes o después de entregar».
Detalla registro, destinatarios, publicación bajo bloqueo, avisos por tandas,
estados abierta/en seguimiento/resuelta y cierre del lote por incidencia.

**Clasificación.** Diferencia entre requisito y documentación K013 anterior: la
revisión inicial no localizó la sección I (el PDF no es buscable como texto) y
modeló la incidencia como posterior a una entrega. Se corrigieron modelo, estados,
casos de uso (CU-RF11-01 a 03) y matriz para ligarla al lote.

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

**Pregunta concreta original.** ¿Quién puede reportar, atender y resolver una
incidencia, y qué desenlaces comerciales puede producir?

**Resultado.** Resuelta por E1. Anexo I p. 26: «Cualquier usuario puede reportar
objetos a los que tenga acceso. Un operador del establecimiento o administración
revisa y publica la incidencia», y publicar un aviso o cerrar un lote son
decisiones explícitas. Anexo E p. 7 lo repite: el operador autorizado o
administración comunica el problema a todos los vinculados y decide si cierra
pendientes. El único desenlace sobre el lote es el cierre por incidencia; E1 no
define reembolsos, sanciones ni reapertura, por lo que no se modelan.

**Efecto sobre K013.** El criterio queda cubierto también para incidencias. La
administración como rol sigue sin gestión propia, igual que las membresías.

## Decisiones pendientes

| ID | Pregunta concreta | Fuente de la duda | Elementos afectados | Rol que debe resolver |
| --- | --- | --- | --- | --- |
| D-04 | ¿Puede un usuario crear una solicitud nueva sobre un lote cuando aún tiene una reserva confirmada activa? | K003 protege una reserva activa por usuario/lote; ADR 0002 exige reingreso explícito pero deja esta compatibilidad como riesgo futuro. | Compromiso, RF04, FIFO, índice activo. | Producto y dominio. |
| D-05 | Cuando existe una foto de lote no lista/no autorizada, ¿se bloquea la publicación completa o se omite sólo esa foto? | Anexo I p. 25 exige fotos opcionales y fijas; OpenAPI/K010 sólo exige cero fotos válido. | Foto de lote, publicación, consulta, K014. | Producto y seguridad. |
| D-06 | Al retirar un lote o al vencer/cancelar una reserva, ¿qué transiciones exactas aplican a `R`, ofertas activas y solicitudes en espera? | RF02 exige retirar para corregir; ADR 0002 define oferta parcial pero remite el recorrido de reserva a reglas existentes no materializadas. | Lote, compromiso, inventario, CU-RF05-01. | Producto y dominio. |
| D-07 | ¿RF03 permite descubrimiento sin sesión y qué información/fotos puede ver cada actor? | OpenAPI aclara que su GET actual es sólo de operador y no implementa descubrimiento RF03. | Consulta de lote, fotos, autorización, CU-RF03-01. | Producto y seguridad. |
| D-08 | ¿Qué clave de idempotencia, retención de resultado y respuesta de reintento se aplican a asignación, acreditación e incidencias? | Anexos H p. 20 exige claves para asignación/incidencias; no fija su representación en el dominio ni el contrato HTTP. | Oferta, entrega, incidencia y concurrencia. | Dominio y arquitectura. |

## Corrección posterior (2026-09-27)

La revisión de la semana encontró que el anexo I p. 26 y el anexo A p. 3 de E1
definen RF11. Se resolvieron D-01 y D-03 y se reemplazó la «incidencia posterior
ligada a una entrega» por la incidencia de lote en
[modelo-inicial.md](modelo-inicial.md), [casos-de-uso.md](casos-de-uso.md) y esta
matriz. Las tarjetas K043–K046 ya seguían a E1; el resto de K013 no cambia.

## Verificación documental

Se revisaron los enlaces relativos añadidos contra los archivos existentes y se
ejecutó `git diff --check` para los cuatro cambios documentales. Los diagramas
Mermaid se conservaron como fuente editable en `modelo-inicial.md`; el repositorio
no incluye un renderizador Mermaid, por lo que no se declara un renderizado.
