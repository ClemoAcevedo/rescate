# ADR 0021: responsable y avisos de cada versión para el operador

Estado: adoptada en K046. Complementa ADR 0012 y 0020.

## Decisión

Cada versión de una incidencia informa a los operadores del establecimiento el correo de
quien la publicó (`incident_versions.published_by`), aunque después deje de ser miembro. Es
la única identidad que guarda la cuenta, y la tarjeta pide conservar responsable, motivo y
fecha de cada resolución. Solo la reciben operadores actuales del mismo establecimiento; nunca
llega a quienes reciben el aviso, y la API no identifica a quien reportó ni a los destinatarios.

El estado de los avisos de una versión se calcula al leer desde `incident_recipients` y
`notifications`: pendiente si el destinatario aún no tiene aviso (sin evento, o con el
evento en cola, reintentando o fallido para Operación), generado si el aviso existe sin
lectura y leído si tiene `read_at`. Los tres suman `recipientCount`. No se agregan columnas
ni contadores: la fila del destinatario, el evento y el aviso ya registran cada paso, y la
lectura la escribe la propia persona.

`GET /establishments/{establishmentId}/incidents` reúne las incidencias de todos los lotes con
el permiso del panel (404 si no existe, 403 si no es miembro), en páginas de 20 y con filtro
por estado. Gestionar una incidencia sigue en las rutas del lote de K043/K044.

## Alternativas descartadas

- **Mostrar solo «Tú» u «Otro operador».** Oculta quién resolvió cuando hay varias personas
  en el local y no permite atribuir la resolución que pide la tarjeta.
- **Contadores de avisos en `incident_versions`.** Habría que actualizarlos desde el worker y
  desde la lectura de cada persona, con otra fuente de verdad que conciliar.
- **Identificar a los destinatarios o a quien reportó.** El operador no lo necesita para
  gestionar la incidencia y expondría a quienes reservaron.
- **Recorrer los lotes desde la web para armar la lista.** Una consulta por lote haría que la
  vista dependiera de cuántos lotes tiene el establecimiento y del cupo de lecturas.
