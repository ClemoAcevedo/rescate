# ADR 0006: inventario del lote y bloqueo común

Estado: adoptada para K021. Reemplaza el inventario derivado de
[ADR 0004](0004-reserva-directa-idempotente.md); su idempotencia se conserva.
Anexos B p. 4 exige Q = F + O + R + E + X con contadores no negativos, sin
sobreasignación, y que los contadores se contrasten con sus registros: una
discrepancia bloquea nuevas asignaciones del lote y genera revisión.
[ADR 0002](0002-ofertas-parciales.md) fija cómo se mueven O y R.

## Decisión

`lots` guarda O (ofrecidos), R (reservados), E (retirados) y X (no asignables),
enteros con default 0. F (libres) es una columna generada `Q - O - R - E - X`, así
que la suma se cumple por construcción. Dos CHECK la completan:
`lots_inventory_counters_check` (O, R, E, X ≥ 0) y `lots_inventory_total_check`
(O + R + E + X ≤ Q, es decir F ≥ 0). La base rechaza la sobreasignación aunque una
regla de Application falle, y la transacción revierte la reserva y su clave.

Cada comando mueve contadores en la misma transacción que crea o cambia el
compromiso, después de bloquear el lote:

| Comando | Movimiento |
| --- | --- |
| Reserva directa | F → R |
| Ofrecer, aceptar, liberar oferta (ADR 0002) | F → O, O → R, O → F u O → X |
| Cancelar o vencer reserva | R → F, o R → X si el lote ya no es asignable |
| Acreditar retiro | R → E |

[lot-lock.ts](../../api/src/infrastructure/postgres/lot-lock.ts) concentra el
bloqueo para todos esos comandos: `lockIntent` serializa la clave por actor y
comando, y `lockLot` toma `FOR UPDATE` sobre el lote y después lee
`clock_timestamp()`. Domain decide con ese instante de PostgreSQL, no con el reloj
del proceso, así que plazos y estado se evalúan con lo vigente tras la espera. Ambos
fijan `lock_timeout` en 2 s (anexos H p. 20).

Bajo el bloqueo, antes de asignar, el comando contrasta cada contador con los
registros que lo respaldan; hoy R con la suma de reservas confirmadas. Si difieren,
Application rechaza la asignación (409) y HTTP registra `inventory_discrepancy` con
el lote para revisión. Reproducir una clave ya confirmada no asigna y sigue
funcionando. O, E y X sumarán su contraste cuando existan sus registros.

## Alternativas descartadas

- **Derivar libres de `SUM(commitments)`.** Era el cálculo de K015. Ninguna
  restricción impide la sobreasignación; depende de que todos los comandos tomen el
  bloqueo y relean correctamente.
- **Constraint trigger sobre `commitments`.** Garantiza R = Σ confirmadas, pero el
  modelo no usa triggers y ocultaría el movimiento que ADR 0002 hace explícito.
- **Guardar F además de O, R, E y X.** Repite un valor derivable y obliga a
  editar F cuando cambia Q en un borrador.

## Consecuencias

Ninguna restricción obliga a que R coincida con la suma de reservas confirmadas.
El repositorio escribe ambas cosas con el mismo cliente, y el contraste previo a
cada asignación detiene el lote si llegan a diferir. Los fixtures SQL que insertan
compromisos también deben mover R. `db:test:discovery:compose` prueba el bloqueo
por discrepancia y concilia todos los lotes al terminar.
