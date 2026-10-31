# ADR 0017: gestionar disponibilidad sin reescribir el lote publicado

Estado: adoptada a partir del feedback de E2. Complementa ADR 0006, 0008 y 0010.

## Decisión

La cantidad Q describe lo ofrecido originalmente. Una venta presencial o merma
retira solo unidades F, pasando a X con motivo y autor en `lot_operations`. No se
usa E: representa exclusivamente una entrega acreditada mediante la app. No se
reduce Q ni se invade lo ya ofrecido o reservado. La cola se asienta antes de
medir los libres, conservando su prioridad.

`paused_at` suspende nuevas asignaciones mientras el lote sigue publicado. La pausa
no es un cierre: conserva reservas, ofertas emitidas y posición FIFO; las ofertas
pueden aceptarse hasta su plazo. Cancelar o vencer una oferta libera a F mientras
la ventana siga abierta, sin ofrecer a la siguiente persona hasta reanudar.
El worker sigue venciendo el lote a la misma hora y limpia la pausa al cerrarlo.

Retirar es un cierre lógico irreversible: cancela reservas pendientes, invalida
códigos, termina la cola, mueve F/O/R a X y conserva E e historial. No borra filas
ni implementa reportes o seguimiento de incidencias. Retiro y entrega compiten por
el mismo bloqueo; si una entrega ya confirmó, se conserva.

Las cuatro operaciones usan sesión, membership actual, versión y una clave por
actor. La autorización se comprueba antes del bloqueo y dentro de él. Historial,
efectos, avisos y resultado del reintento se confirman juntos, usando el reloj de
PostgreSQL posterior al bloqueo. El reintento devuelve el resultado original aun
si el lote cambió después; la web consulta luego el estado actual.

Las fotos siguen siendo opcionales. `PHOTO_MAX_PER_LOT` conserva tres por defecto y
permite entre una y cincuenta; la API comunica el cupo a la web. SQL exige posición
positiva y unicidad de las posiciones activas; el cupo se aplica bajo el bloqueo del
lote. No se requiere migrar el esquema cada vez que cambia el cupo. Reducirlo no
borra las fotos existentes, pero impide agregar hasta volver a estar bajo el límite.

El cierre de retiro resuelve «ofrecer solo por hoy». No se agrega una fecha de vida
útil independiente ni se transforma X automáticamente en desperdicio físico.

## Alternativas descartadas

- Editar Q después de publicar: altera la declaración y las métricas históricas.
- Pausar cerrando o cancelando todo: pierde la reversibilidad y la posición FIFO.
- Borrar físicamente el lote: rompe trazabilidad de reservas, entregas y avisos.
- Conservar el máximo de tres en SQL y web: cambiar el cupo exige coordinar una
  migración con un despliegue y vuelve a introducir fuentes de verdad paralelas.
