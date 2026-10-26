# Rendimiento y carga

Las metas, la escala y el protocolo están en el anexo H de E1 (pp. 18–19): búsqueda
P95 ≤ 1000 ms, reserva P95 ≤ 1500 ms y menos de 1 % de errores inesperados, medidos con
k6 sobre una semilla reproducible. Los umbrales no se ajustan para aprobar; cambiarlos
exige una decisión de diseño.

## Medir

Con la base de Compose levantada (`docker compose --env-file .env.example up -d --wait db`):

```bash
npm --prefix api run db:measure:scale:compose
```

El script crea una base aislada `rescate_k032_test_*`, la migra y la siembra, analiza
los planes, levanta la API real y ejecuta k6 (`grafana/k6:1.3.0`) en Docker. No toca la
base de desarrollo ni corre en CI: mide, no aprueba cambios. `WARMUP_SECONDS` y
`MEASURED_SECONDS` cambian la duración (por omisión 30 s y 120 s). Los resultados quedan
en `api/.k032-results/<base>/`, fuera de git:

| Archivo | Contenido |
| --- | --- |
| `plans.txt` | `EXPLAIN (ANALYZE, BUFFERS)` de cada sentencia, por operación |
| `k6-summary.json` | Métricas completas de k6 |
| `resources.json` | Equipo, versiones, commit, tamaños de tablas, CPU y memoria de API y PostgreSQL, esperas por bloqueo |
| `seed.json` | Sesiones y lotes que usa k6; contiene secretos de sesión locales |

Las cifras de cada medición van en la descripción del PR, no en este documento.

## Semilla

[`seed-scale.mjs`](../api/scripts/seed-scale.mjs) sigue la historia de prueba del anexo H:
10 establecimientos, 1000 cuentas, 10 000 lotes (200 vigentes) y 50 000 compromisos con
estados terminales, más entregas, espera histórica, una cola vigente y avisos. Los datos
salen de SQL con `setseed`, y la semilla comprueba Q = F + O + R + E + X en todos los lotes.
Los vigentes se reparten en tres grupos para que cada operación tenga datos válidos:
lotes sin stock con cola, lotes donde cada sesión de carga ya tiene reservas para
cancelar y lotes donde reserva. Las sesiones se insertan directamente, porque el
límite de login por IP impide abrir 50 sesiones desde k6. Los mensajes de chat se
agregan cuando exista su tabla.

## Planes

[`explain-scale.mjs`](../api/scripts/explain-scale.mjs) recorre búsqueda, detalle,
reserva, historial, cancelación, ingreso a la espera, avisos, el
[panel del establecimiento](panel.md) y los trabajos del worker con la API real.
Intercepta `pg` y analiza cada sentencia dentro de un savepoint que se revierte, así
que el plan corresponde al SQL vigente de los repositorios. El resumen marca los
`Seq Scan` que leen más de 1000 filas.

## Carga

[`load/k032.js`](../api/load/k032.js) aplica la mezcla de E2 del anexo: 18 búsquedas, una
reserva y una cancelación por segundo a tasa constante. La preparación no cuenta en
p50, p95 ni errores. Cada reserva y cada cancelación usa un par cuenta/lote distinto,
de modo que un 409 es un error real y no una colisión de datos. Una iteración
descartada hace fallar la ejecución. El generador corre en el mismo equipo que la
API y PostgreSQL; el anexo exige declarar esa interferencia. La medición de E3 (tres
ensayos de 2 + 10 minutos a 20 solicitudes por segundo) amplía este escenario.

## Índices

El cuadre del inventario (`lotReconciledSql`) suma las entregas de un lote uniendo
`commitments` en cualquier estado, y corre bajo el bloqueo del lote en cada reserva,
cancelación y comando de la cola. `commitments_lot_idx` cubre esa unión;
`commitments_lot_confirmed_idx` sigue sirviendo a las sumas de reservas confirmadas.

Compromisos e historial del [panel](panel.md) leen toda la historia de un establecimiento,
cerca del 10 % de `commitments` y `waitlist_entries` en la semilla. Ahí el planificador
prefiere recorrer la tabla y unirla por hash aunque exista `commitments_lot_idx`, y cada
consulta tarda decenas de milisegundos. Por eso el panel no agrega índices.
