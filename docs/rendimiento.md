# Rendimiento y carga

Las metas, la escala y el protocolo están en el anexo H de E1 (pp. 18–19 y 23):

- búsqueda con P95 ≤ 1000 ms;
- reserva con P95 ≤ 1500 ms;
- menos de 1 % de errores inesperados por operación;
- chat visible con P95 ≤ 7 s;
- tareas vencidas con P95 ≤ 30 s;
- cero errores de integridad en las pruebas críticas.

Los umbrales no se ajustan para aprobar; cambiarlos exige una decisión de diseño.

## Medir

Con la base de Compose levantada (`docker compose --env-file .env.example up -d --wait db`):

```bash
npm --prefix api run db:measure:scale:compose
npm --prefix api run db:measure:e3:compose
```

El primero corre la mezcla de E2 en un ensayo de 30 s de preparación y 120 s medidos.
El segundo sigue el protocolo de E3: tres ensayos de 120 + 600 s, unos 45 minutos.
`TRIALS`, `MIX` (`e2` o `e3`), `WARMUP_SECONDS` y `MEASURED_SECONDS` cambian la corrida.

Cada ensayo restaura la semilla en una base nueva `rescate_k032_test_*`: la migra, la
siembra y analiza los planes. Después levanta API y worker con `docker compose run --no-deps`,
usando la imagen del árbol actual, y ejecuta k6 (`grafana/k6:1.3.0`) en la red del
proyecto contra el contenedor de la API. `web` no se levanta: k6 reproduce contra la API la
carga del navegador. Al terminar, el ensayo exige `/health` con el worker sano, espera a
que el outbox quede vacío, verifica las invariantes y retira los contenedores.

El script no toca la base ni los servicios de desarrollo y no corre en CI: mide, no
aprueba cambios. Borra la base de un ensayo que cumple y conserva la de uno que falla o se
interrumpe. Ctrl+C, `SIGTERM` o cerrar la terminal retiran los contenedores del ensayo en
curso; si el proceso muere sin hacerlo (`SIGKILL`), la corrida siguiente los retira.
Termina con código distinto de cero si un ensayo no cumple, e indica cuál. Los resultados
quedan en `api/.k032-results/<corrida>/`, fuera de git:

| Archivo | Contenido |
| --- | --- |
| `informe.md` | Ambiente frente a los mínimos del anexo, metas, una tabla por ensayo sin promediar y cumple o no cumple por meta |
| `ensayo-N/k6-summary.json` | Métricas completas de k6 |
| `ensayo-N/resources.json` | Commit y estado del árbol, equipo, VM de Docker, límites y plataforma de los contenedores, versiones, pools, tiempos de siembra y arranque, tamaños de tablas, CPU y memoria por contenedor, esperas por bloqueo y estados por operación según la API |
| `ensayo-N/invariants.json` | Conteo base, éxitos y escrituras inciertas de k6 y resultado de cada invariante |
| `ensayo-N/plans.txt` | `EXPLAIN (ANALYZE, BUFFERS)` de cada sentencia, por operación |
| `ensayo-N/api.log`, `worker.log` | Registro por solicitud y del worker ([operación](operacion.md)) |
| `ensayo-N/seed.json` | Sesiones, lotes y conversaciones que usa k6; contiene secretos de sesión locales |

Las cifras de cada medición van en la descripción del PR, no en este documento.

## Semilla

[`seed-scale.mjs`](../api/scripts/seed-scale.mjs) sigue la historia de prueba del anexo H:
10 establecimientos, 1000 cuentas, 10 000 lotes (200 vigentes), 50 000 compromisos con
estados terminales y 100 000 mensajes de chat, más entregas, espera histórica, una cola
vigente y avisos. Los datos salen de SQL con `setseed`, y la semilla comprueba
Q = F + O + R + E + X en todos los lotes.

Los vigentes se reparten en tres grupos para que cada operación tenga datos válidos:

- lotes sin stock con cola;
- lotes donde cada sesión de carga ya tiene veinte reservas para cancelar;
- lotes donde reserva.

Las sesiones se insertan directamente, porque el límite de login por IP impide abrir 50
sesiones desde k6.

Veinte de las cincuenta sesiones tienen el chat visible (anexo H p. 18). Cada una conversa
en su propia reserva, en un lote del grupo de reserva que k6 no alcanza. Esa conversación
tiene 60 mensajes que alternan titular y operador, y sigue abierta al menos dos horas
después de sembrar. El resto de los mensajes cae en compromisos históricos, dentro de la
vida de cada conversación. Cada mensaje trae su evento procesado y el aviso para la otra
parte. Las conversaciones cerradas hace 30 días o más ya no tienen texto, igual que tras
la [retención](chat.md), y sus avisos quedan leídos.

## Planes

[`explain-scale.mjs`](../api/scripts/explain-scale.mjs) recorre con la API real búsqueda,
detalle, reserva, historial, cancelación, ingreso a la espera, avisos, lectura y envío de
chat, el [panel del establecimiento](panel.md) y los trabajos del worker. Intercepta `pg`
y analiza cada sentencia dentro de un savepoint que se revierte, así que el plan
corresponde al SQL vigente de los repositorios. El resumen marca los `Seq Scan` que leen
más de 1000 filas.

## Carga

[`load/k032.js`](../api/load/k032.js) aplica a tasa constante la mezcla que fija `MIX`:

- **E2:** 18 búsquedas, una reserva y una cancelación por segundo.
- **E3:** 10 búsquedas, cuatro lecturas de chat, tres de bandeja, una reserva, una
  cancelación y un envío de mensaje por segundo.

Cada reserva y cada cancelación usa un par cuenta/lote distinto. Cada cuenta con chat envía
un mensaje cada 20 s, bajo el cupo de mensajes ([seguridad](seguridad.md)). La lectura de
chat pide `after=0`, es decir, la primera página completa de 50 mensajes; es más exigente que la
consulta periódica, que solo trae los nuevos. Cada solicitud espera hasta 10 s, como el
navegador (anexo H p. 20). Si la semilla no alcanza para la duración pedida, k6 se
detiene antes de empezar.

Cada respuesta se clasifica así:

- **Éxito:** estado esperado y cuerpo mínimo válido. La semilla garantiza datos, así que
  una página vacía no es un éxito.
- **Rechazo esperado:** un 409 cuyo mensaje es un motivo documentado de la operación (sin
  stock, reserva terminada o conversación cerrada), o un 429 por cupo. Se informa aparte.
  Como los datos están preparados para que todo sea válido, un rechazo esperado en la fase
  medida invalida el ensayo.
- **Error inesperado:** todo lo demás: falla de red, timeout, 5xx, un 409 por otro motivo
  o un 2xx con cuerpo incorrecto. Debe quedar bajo 1 % en cada operación.

El P95 que se compara con las metas incluye los errores inesperados; una solicitud sin
respuesta cuenta 10 s. El informe muestra también el P95 de los éxitos. Los rechazos
esperados no entran en ninguno de los dos. Una escritura sin respuesta, con 5xx o con 2xx
inválido es incierta porque pudo confirmarse; las invariantes de reservas, cancelaciones
y mensajes aceptan para ella un delta entre los éxitos y los éxitos más las inciertas.

La preparación no cuenta para los umbrales. Sus latencias se informan como
calentamiento: la API y el worker arrancan en frío, pero PostgreSQL ya pasó por la
semilla y los planes. El bloqueo, el DNS, la conexión inicial por fase, las conexiones
nuevas y el arranque medido desde el host también se informan aparte. Una iteración
descartada hace fallar el ensayo.

## Integridad

```bash
npm --prefix api run db:test:integrity:compose
```

[`test-integrity.mjs`](../api/scripts/test-integrity.mjs) cubre, a la escala del anexo H
(pp. 19 y 23), los casos críticos que no tenían otra prueba de ese tamaño. Crea una base
aislada `rescate_k039_test_*` y usa la API real por HTTP, con sesiones sembradas por SQL y
un ritmo bajo los límites por IP y por usuario. La base se conserva; `db:test:integrity`
con `DATABASE_URL` repite la suite sobre una existente.

| Prueba del anexo | Dónde |
| --- | --- |
| Último pack: 20 personas por un pack en 100 lotes nuevos | Integridad |
| Misma intención: 20 reintentos simultáneos de una clave, en reservas y en el chat | Integridad; por HTTP el cupo de mensajes deja pasar tres envíos, y el caso de uso prueba los 20 en la persistencia |
| Cancelar y retirar en competencia | [Reservas](reservas.md#pruebas) |
| Oferta antes, en y después del plazo con el trabajador detenido | Integridad (plazo cruzado mientras otra transacción bloquea el lote); [cola de espera](cola-de-espera.md#pruebas) |
| Aislamiento de usuarios y operadores ajenos | Integridad (operador de otro establecimiento); [seguridad](seguridad.md#pruebas) y [chat](chat.md) |
| Caída y recuperación del trabajador y respuesta perdida | [Vencimientos](vencimientos.md#pruebas) y [reservas](reservas.md#pruebas) |
| Restaurar copia | K053 (#56) |
| Tareas vencidas: P95 ≤ 30 s con 100 ofertas | Integridad, con el worker real y todas las ofertas venciendo a la vez |
| Chat visible: P95 ≤ 7 s en otro navegador | Requiere la vista del chat, K038 (#41) |

Los resultados quedan en `api/.k039-results/<base>/integrity.json`, junto con el
ambiente y el hash de los scripts. Cada caso registra la referencia al anexo, los
parámetros, lo esperado y lo observado, y sus estados HTTP separados en esperados (409 sin
stock u oferta vencida, 429 del cupo de mensajes, 403 y 404 de accesos ajenos) e
inesperados. Un caso falla por integridad, por una aserción o por una respuesta fuera de
OpenAPI. Un 429 de otro límite, un 5xx o un timeout se cuenta como inesperado y deja
`expectedResponsesMet` en falso sin decidir el caso. La demora de una tarea vencida es
`processed_at` de su evento `offer_expired` menos `offer_expires_at`. Su meta se informa
como cumple o no cumple, sin hacer fallar la suite. Las latencias de los casos HTTP son
informativas: la API corre en el mismo proceso que el generador, y la meta de reserva la
mide k6.

## Índices

El cuadre del inventario (`lotReconciledSql`) suma las entregas de un lote uniendo
`commitments` en cualquier estado, y corre bajo el bloqueo del lote en cada reserva,
cancelación y comando de la cola. `commitments_lot_idx` cubre esa unión;
`commitments_lot_confirmed_idx` sigue sirviendo a las sumas de reservas confirmadas.

Compromisos e historial del [panel](panel.md) leen toda la historia de un establecimiento,
cerca del 10 % de `commitments` y `waitlist_entries` en la semilla. Ahí el planificador
prefiere recorrer la tabla y unirla por hash aunque exista `commitments_lot_idx`, y cada
consulta tarda decenas de milisegundos. Por eso el panel no agrega índices.

## Limitaciones

- Generador, API, worker y PostgreSQL corren en un mismo equipo. El anexo exige declarar
  esa interferencia: el resultado no sustituye la prueba con otro equipo (p. 18).
- Chat visible depende de la vista web del chat, K038 (#41).
- Restaurar copia y conciliar después es K053 (#56).
