# ADR 0008: estado del lote como enum y cierre lógico

Estado: adoptada a partir del feedback de E2. Reemplaza el `text` + CHECK de
`lots.status` del [modelo inicial](../modelo-inicial.md) y deja listos los estados
de cierre para el vencimiento (K028) y el retiro o cierre del lote (K044).

## Decisión

`lots.status` es el enum `lot_status` con `draft`, `published`, `expired` y
`withdrawn`. Vencido y retirado son **cierres lógicos**: el lote deja de ofrecerse,
pero la fila se conserva con sus fotos, reservas, entregas e inventario. `closed_at`
marca el instante del cierre y es obligatorio justo en esos dos estados
(`lots_closed_check`); `published_at` es obligatorio en todo estado distinto de
borrador.

Las búsquedas públicas siguen filtrando `status = 'published'`, así que un lote
cerrado desaparece del listado sin código adicional. El operador lo sigue viendo en
«Mis lotes» con su estado.

El worker implementa `published → expired` y la gestión del operador implementa
`published → withdrawn`, ambas con el bloqueo común de
[ADR 0006](0006-inventario-del-lote.md) y el movimiento del inventario pendiente a X.
La pausa es reversible y conserva el estado publicado; ver
[ADR 0017](0017-gestion-de-publicaciones.md). K044 (#49) incorpora el circuito de cierre por incidencia.

## Alternativas descartadas

- **Mantener `text` + CHECK.** Funciona, pero el tipo no documenta los valores y el
  ayudante pidió explícitamente un enum. Agregar un valor más adelante es un
  `ALTER TYPE … ADD VALUE`, igual de simple que reescribir el CHECK.
- **Borrar la fila (hard delete).** Rompería las FK de reservas, entregas y fotos, y
  se perdería el historial que necesitan los avisos de incidencias y la conciliación.
- **Solo `deleted_at` sin estado.** Mezcla vencido y retirado, que tienen reglas y
  textos distintos para el usuario.
