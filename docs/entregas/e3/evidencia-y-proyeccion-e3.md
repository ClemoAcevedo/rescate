# K041: evidencia de proceso y proyección

Tarjeta [K041 (#42)](https://github.com/ClemoAcevedo/rescate/issues/42). Responsable: Vicente Reñasco. Revisor: Jorge Molina.

Corte: datos de GitHub y de producción al 31-10-2026, 15:55 hora de Chile (18:55 UTC). Entre las 16:32 y las 16:38 se revisaron otra vez y no había cambios. La presentación de E3 va en K042. La pauta también pide una planilla de estimaciones y plan de trabajo; el borrador local de esa planilla tiene un corte anterior (15:38) y hay que regenerarlo antes de usarlo.

## 1. Resumen

Trabajamos con ramas y PR a `development`. El merge exige los cinco checks del CI y no pide aprobación humana. Los releases llevan `development` a `main`, y cada deploy termina con un smoke. El 31-10 se cerraron siete tarjetas en un solo lote, y casi nunca llenamos el seguimiento de las tarjetas.

Según el tablero quedan 27 tarjetas abiertas, con 83,25 h estimadas: 6,75 h de E3 y 76,5 h de E4. Hay otras cuatro tarjetas de E3 cerradas (12 h) cuya evidencia de cierre está incompleta. Fuera del plan quedan 9 issues sin estimar, y no encontramos SCA ni SAST en el CI ni en las tarjetas.

Al ritmo que llevamos, 23,3 h estimadas cerradas por semana, el trabajo de S08 a S10 (75,5 h, que incluye P3 de E3) equivale a 3,2 semanas. Contra una referencia de tres semanas faltan unas 6 h. Si además pasan a S08 K041, R07 y la estimación completa de esas cuatro tarjetas (escenario B), faltan unas 23 h. Solo con nuestro mejor ritmo de dos semanas, y sin ese arrastre, el trabajo cabe en tres semanas. Ninguna de estas cifras es el margen efectivo antes del freeze de E4 (21-11), porque no sabemos cuántas horas hay disponibles hasta esa fecha.

No hay evidencia de que producción sea inviable en su totalidad: a las 16:33 la API y la base respondían. Pero `/api/health` informa `worker: stopped`, es decir, el worker no registra un ciclo exitoso en los últimos 60 s, y las funciones que dependen de él están en riesgo. El smoke del último deploy (31-10, 01:11 UTC) lo encontró sano, pero eso ya no describe el estado actual. Producción tampoco tiene #177. El guion de demo de #178 es en producción y usa el worker; la pauta permite una demo local, así que hacerla en local es una alternativa que el equipo tiene que decidir. Con esta evidencia no está demostrada la inviabilidad que, según K041, obliga a avisar al profesor.

## 2. Horas estimadas y horas reales

Todas las horas de este informe son estimaciones, sacadas de la tabla «Esfuerzo estimado» de cada tarjeta. Horas reales casi no hay. Solo K031 anotó «Horas reales equipo» (2 h del responsable), ninguna tarjeta tiene «Inicio real» ni «Días de ciclo», y la hoja Registro del [plan Kanban](https://drive.google.com/file/d/1GoUS3VCKQ9UOpAPXW75L4kxAIU55qRBS/view) estaba vacía al 31-10.

Así que no podemos comparar lo estimado con lo trabajado. Lo que aquí llamamos velocidad es la suma de horas estimadas de las tarjetas que cerramos cada semana. Sirve para ver el avance contra el plan, no el esfuerzo. Y como depende de cuándo se cerró el issue, arrastra el problema de los cierres con evidencia incompleta (sección 3).

Para los tiempos usamos lo que sí queda en GitHub: cuánto tarda un PR en integrarse, cuánto pasa entre el primer PR integrado y el cierre de la tarjeta, y cuántas tarjetas cerraron a tiempo. No podemos medir cuánto pasa una tarjeta en cada columna, porque el tablero no guarda la fecha de cada cambio de estado.

## 3. Cómo trabajamos

Cada tarjeta avanza en el tablero «Rescate - Kanban» (Backlog, Ready, In progress, In review y Done). El trabajo entra por una rama y un PR a `development`. Ahí corre el CI K006, que prueba web, API, Compose (incluidas las pruebas del worker), migraciones y recorridos HTTPS, y dos revisores automáticos (Gemini y Copilot) comentan el PR. La protección de `main` y `development` exige los cinco checks del CI a todos. El ruleset del repo pide 0 aprobaciones, y [`docs/despliegue.md`](https://github.com/ClemoAcevedo/rescate/blob/development/docs/despliegue.md) (commit `4294215`, 26-10) dice que no se exige aprobación humana. Luego un release lleva `development` a `main`, y el deploy a producción termina con un smoke.

Para cerrar una tarjeta, las reglas de cada issue piden evidencia y revisión aceptada. Es un paso distinto de aprobar el PR.

Al corte, el tablero tenía 50 tarjetas en Done, 26 en Backlog, una en In progress (K041) y ninguna en In review. Backlog muestra 35 elementos porque también incluye los 9 issues sin tarjeta.

### PR

| Indicador | Valor |
| --- | --- |
| PR en total | 90. De los 83 integrados, 62 son de producto y 21 son releases o sincronizaciones de `main`. |
| Tiempo de creación a merge (producto) | Mediana 0,6 h; p90 38,5 h |
| PR de producto sin aprobación humana | 13 de 62: 12 desde el 26-10, cuando quedó escrita la regla, y #101 del 27-09 |
| PR de producto por semana de creación | S01: 8, S02: 11, S03: 11, S04: 6, S05: 7, S06: 4, S07: 15 |
| PR de producto de S07 sin tarjeta | 10 de 15 |
| Autoría de los PR de producto | Clemente 35 (56 %), Jorge 9, Felipe Arnolds 7, Felipe Espinoza 6, Vicente 5 |
| PR de producto con tarjeta abiertos por alguien que no es su responsable | 11 de 41 |

### Cierre de tarjetas

| Indicador | Valor |
| --- | --- |
| Cerradas en o antes de su vencimiento | 12 de 50 |
| Del primer PR integrado al cierre de la tarjeta | Mediana unos 20 min; p90 5,1 días (35 tarjetas) |
| Cerradas que todavía muestran «Horas equipo restantes» | 46 |
| «Estado en el Excel» todavía en «Pendiente» | 69 de 77 |

El 31-10 a las 15:40 se cerraron en lote siete tarjetas: D3, K035, K037, K038, K039, K040 y K042. Ninguna tiene comentario de cierre ni «Seguimiento» lleno, así que tampoco registran la revisión aceptada. K042 y D3 dependen de K041, que sigue abierta, así que se cerraron antes que su predecesora. K035, K037 y K038 (10,5 h) tienen su PR integrado y no les conocemos pendientes. En las otras cuatro (12 h) la evidencia está incompleta:

- K039: [#172](https://github.com/ClemoAcevedo/rescate/pull/172) trae mediciones hechas en local, con el generador en el mismo equipo. La medición en otro equipo y en un servidor que cumpla el anexo H ([#170](https://github.com/ClemoAcevedo/rescate/issues/170)) sigue abierta.
- K040: [#178](https://github.com/ClemoAcevedo/rescate/pull/178) integra el guion de demo, pero su descripción todavía dice que queda en borrador hasta registrar las cinco sesiones con personas.
- D3 y K042: los issues no registran el ensayo ni el envío de la presentación.

Lo que vemos en el proceso:

- Dejamos mucho para el final. En S07 se crearon 15 PR de producto, contra 4 a 7 por semana entre S04 y S06, y 10 de esos 15 no tenían tarjeta.
- Más de la mitad de los PR de producto los abrió una sola persona.
- El tablero no refleja el trabajo a tiempo. Se actualiza tarde y, al cerrar en lote sin anotar evidencia, muestra más avance del que podemos comprobar.

## 4. Defectos y pruebas

| Fuente | Valor |
| --- | --- |
| PR de corrección integrados | 14 de 62 PR de producto |
| CI K006, historial completo | 175 éxitos y 23 fallos (88 %); no se cuentan 16 cancelados |
| Deploy a producción | 5 éxitos y 5 fallos; no se cuentan 9 omitidos. Los 4 fallos seguidos del 26-10 vinieron del smoke de logout. |
| Issues abiertos con etiqueta bug | [#171](https://github.com/ClemoAcevedo/rescate/issues/171): una prueba de carga de más de 5 MiB falla a veces en macOS («fetch failed» en vez de 413). No aparece en CI, y no está comprobado qué ve el navegador. |

Los 14 PR de corrección, por área:

| Área | PR |
| --- | --- |
| Producto | [#107](https://github.com/ClemoAcevedo/rescate/pull/107), [#177](https://github.com/ClemoAcevedo/rescate/pull/177) (feedback de E2) |
| Pruebas y CI | [#120](https://github.com/ClemoAcevedo/rescate/pull/120), [#138](https://github.com/ClemoAcevedo/rescate/pull/138), [#149](https://github.com/ClemoAcevedo/rescate/pull/149) |
| Deploy | [#110](https://github.com/ClemoAcevedo/rescate/pull/110), [#112](https://github.com/ClemoAcevedo/rescate/pull/112), [#113](https://github.com/ClemoAcevedo/rescate/pull/113), [#166](https://github.com/ClemoAcevedo/rescate/pull/166) |
| Revisor automático | [#152](https://github.com/ClemoAcevedo/rescate/pull/152), [#154](https://github.com/ClemoAcevedo/rescate/pull/154), [#167](https://github.com/ClemoAcevedo/rescate/pull/167), [#173](https://github.com/ClemoAcevedo/rescate/pull/173) |
| Otros | [#81](https://github.com/ClemoAcevedo/rescate/pull/81) |

Cuenta como corrección el PR cuyo título parte con «fix» o «Corregir». Los arreglos hechos dentro de un PR de funcionalidad no salen acá.

Qué prueba cada evidencia, y dónde:

- El CI K006 corre en GitHub, no en producción. Su última corrida en `development` ([run 41230226218](https://github.com/ClemoAcevedo/rescate/actions/runs/41230226218), commit `7068526`) pasó sus cinco checks, incluidas las pruebas del worker con PostgreSQL en Compose. No incluye SCA ni SAST.
- Las mediciones de #172 y los recorridos de #178 se hicieron en local.
- La única prueba contra producción es el smoke de cada deploy. El último ([run 41153842944](https://github.com/ClemoAcevedo/rescate/actions/runs/41153842944), 31-10 01:11 UTC) exigió `worker: ok` y pasó; es un resultado de ese momento.

## 5. Qué falta

### Tarjetas abiertas según el tablero

| Semana | Entrega | Tarjetas | Horas estimadas |
| --- | --- | --- | --- |
| S07 | E3 | K041, R07 | 5,5 |
| S08 | E3 y E4 | 8, incluida P3 (presentación de E3) | 26,25 |
| S09 | E4 | 7 | 23,75 |
| S10 | E4 | 8 | 25,5 |
| S11 | E4 | 2, después del freeze de E4 | 2,25 |
| Total | | 27 | 83,25 |

Hasta el freeze de E4 (21-11) quedan 75,5 h en S08 a S10, contando P3 (1,25 h, de E3). A eso puede sumarse parte de las 12 h de K039, K040, D3 y K042 si lo que les falta no se completa; no sabemos cuánto.

### Sin estimar

Estos issues están abiertos y no tienen horas en el plan:

- [#141](https://github.com/ClemoAcevedo/rescate/issues/141): IP del cliente detrás de Vercel y Railway para los límites por origen.
- [#142](https://github.com/ClemoAcevedo/rescate/issues/142): límite propio para el registro de cuentas.
- [#143](https://github.com/ClemoAcevedo/rescate/issues/143): comprobar la membership antes de bloquear la fila del lote.
- [#170](https://github.com/ClemoAcevedo/rescate/issues/170): medir E3 con el generador en otro equipo.
- [#171](https://github.com/ClemoAcevedo/rescate/issues/171): la prueba intermitente de cargas grandes.
- Deuda técnica: [#97](https://github.com/ClemoAcevedo/rescate/issues/97), [#98](https://github.com/ClemoAcevedo/rescate/issues/98), [#99](https://github.com/ClemoAcevedo/rescate/issues/99) y [#103](https://github.com/ClemoAcevedo/rescate/issues/103).

La pauta de E3 también pide SCA y SAST ([diapositiva 1](https://docs.google.com/presentation/d/1jC3dozsuatZU7oPf21LR7vyZbq4yXIWatXBBIDg8nzw/edit#slide=id.g3f99dc8dbd8_0_5811), [diapositiva 2](https://docs.google.com/presentation/d/1jC3dozsuatZU7oPf21LR7vyZbq4yXIWatXBBIDg8nzw/edit#slide=id.g3f99dc8dbd8_0_5870)). No encontramos esas herramientas en `.github/workflows` ni en tarjetas o issues. Es una brecha frente a la pauta; sin un análisis, no sabemos si hay vulnerabilidades.

Si la demo se hace en producción, también falta trabajo de E3 que no está estimado: revisar el worker y decidir el release de #177 (sección 7).

## 6. ¿Alcanzamos?

### Avance contra el plan

| Semana | Fechas | Plan (h) | Cerrado (h) | Plan acumulado | Cerrado acumulado | Diferencia |
| --- | --- | --- | --- | --- | --- | --- |
| S01 | 14-09 a 20-09 | 26,25 | 23,75 | 26,25 | 23,75 | −2,5 |
| S02 | 21-09 a 27-09 | 22,25 | 24,75 | 48,5 | 48,5 | 0 |
| S03 | 28-09 a 04-10 | 26,75 | 19,25 | 75,25 | 67,75 | −7,5 |
| S04 | 05-10 a 11-10 | 26,5 | 34,0 | 101,75 | 101,75 | 0 |
| S05 | 12-10 a 18-10 | 23,5 | 12,5 | 125,25 | 114,25 | −11,0 |
| S06 | 19-10 a 25-10 | 17,5 | 25,5 | 142,75 | 139,75 | −3,0 |
| S07 (en curso) | 26-10 a 01-11 | 25,0 | 22,5 en el tablero | 167,75 | 162,25 | −5,5 |
| S08 | 02-11 a 08-11 | 26,25 | | 194,0 | | |
| S09 | 09-11 a 15-11 | 23,75 | | 217,75 | | |
| S10 | 16-11 a 22-11 | 25,5 | | 243,25 | | |
| S11 | 23-11 a 29-11 | 2,25 | | 245,5 | | |

Entre S01 y S06 cerramos 139,75 de las 142,75 h planificadas (98 %). Las 22,5 h de S07 vienen todas del cierre en lote: 10,5 h son de tarjetas con PR integrado y sin pendientes conocidos, y 12 h de tarjetas con evidencia incompleta. S07 termina el 01-11 a las 23:59.

### Capacidad

| Dato | Valor | Fuente |
| --- | --- | --- |
| Capacidad planificada | 6 h por persona por semana; 30 h por semana para el equipo | [Plan Kanban, hoja Carga](https://drive.google.com/file/d/1GoUS3VCKQ9UOpAPXW75L4kxAIU55qRBS/view) |
| Velocidad observada | 23,3 h estimadas por semana: media de S01 a S06, con semanas entre 12,5 y 34 h | Tabla de avance |
| Mejor y peor ritmo de dos semanas | 26,6 h por semana (media de S03 y S04) y 19,0 h por semana (media de S05 y S06), entre los pares S01-S02, S03-S04 y S05-S06 | Tabla de avance |
| Ritmo que pide el plan de S08 a S10 | 25,2 h por semana (75,5 h en tres semanas de referencia) | Tarjetas abiertas |

Las 30 h son lo que se planificó, no una disponibilidad que hayamos vuelto a confirmar. Las 6 h por persona constan en la hoja Carga del plan y no se han revalidado. Como antecedente, al inicio del semestre el equipo estimó que el ramo considera 10 h semanales, menos 2 h 20 min de clase, lo que deja 7 h 40 min por persona fuera de clase, y que había que reservar parte de eso para estudio e imprevistos. Fue una estimación inicial y ajustable, no un compromiso actual de cada uno. Lo que efectivamente cerramos son 23,3 h estimadas por semana.

S07 queda fuera de la velocidad porque no ha terminado y su cierre en lote no tiene toda la evidencia.

### Escenarios al freeze de E4 (21-11)

El freeze cae el sábado 21-11 a las 23:59, un día antes de que termine S10. No sabemos cuántas horas podemos trabajar de verdad hasta esa fecha, así que comparamos contra una referencia de tres semanas (S08 a S10):

- semanas equivalentes = trabajo ÷ velocidad;
- margen con 3 semanas de referencia = velocidad × 3 − trabajo.

La columna «Cae en» ubica el término suponiendo que el trabajo se reparte parejo los siete días desde el 02-11. Es solo una orientación.

El escenario A toma el tablero tal como está: K041 y R07 cierran el 01-11 y quedan 75,5 h para S08 a S10. El B suma a S08 las 5,5 h de K041 y R07 y la estimación completa de las cuatro tarjetas con evidencia incompleta (12 h), en total 93,0 h. Es un escenario conservador e ilustrativo, no un tope: no sabemos cuántas horas les quedan realmente, y el trabajo sin estimar podría sumar más.

| Escenario | Velocidad (h/sem) | Trabajo (h) | Semanas equivalentes | Cierre esperado en 3 semanas (h) | Margen con 3 semanas (h) | Cae en (orientativo) |
| --- | --- | --- | --- | --- | --- | --- |
| A, mejor ritmo | 26,6 | 75,5 | 2,8 | 79,9 | +4,4 | Final de S10 |
| A, ritmo observado | 23,3 | 75,5 | 3,2 | 69,9 | −5,6 | Inicio de S11 |
| A, peor ritmo | 19,0 | 75,5 | 4,0 | 57,0 | −18,5 | Final de S11 |
| B, mejor ritmo | 26,6 | 93,0 | 3,5 | 79,9 | −13,1 | Mitad de S11 |
| B, ritmo observado | 23,3 | 93,0 | 4,0 | 69,9 | −23,1 | Final de S11 |
| B, peor ritmo | 19,0 | 93,0 | 4,9 | 57,0 | −36,0 | Semana del 30-11 |

Los cálculos usan las velocidades sin redondear (26,625; 23,29 y 19,0).

Los márgenes de la tabla son contra la referencia de tres semanas, no el margen efectivo antes del freeze; ese depende de la disponibilidad real, que está pendiente. El freeze deja fuera el domingo 22-11; si ese día no se trabaja, no cambia nada. Solo como ejemplo, con un reparto parejo de los siete días caben 20 de 21 días (2,86 semanas) y el margen de «A, mejor ritmo» bajaría de +4,4 a +0,6 h. Ese reparto es un supuesto ilustrativo, no una disponibilidad validada.

Al ritmo histórico y sin ajustar el alcance, el trabajo de S08 a S10 no cabe en la referencia de tres semanas: faltan unas 6 h, o unas 23 h en el escenario B. Es una brecha contra esa referencia, no contra la capacidad real, que no conocemos. Lo que está sin estimar solo agranda la brecha.

### Carga por persona en S08 a S10

Suma las horas como responsable, como revisor y de participación en R08 a R10, D4 y P3.

| Persona | Responsable | Revisión | Participación | Total | Capacidad planificada | Ritmo del equipo repartido en partes iguales |
| --- | --- | --- | --- | --- | --- | --- |
| Clemente Acevedo | 11,5 | 1,75 | 2,5 | 15,75 | 18 | 14,0 |
| Felipe Arnolds | 11,0 | 2,25 | 2,0 | 15,25 | 18 | 14,0 |
| Felipe Espinoza | 11,25 | 1,75 | 1,75 | 14,75 | 18 | 14,0 |
| Jorge Molina | 12,0 | 1,5 | 1,75 | 15,25 | 18 | 14,0 |
| Vicente Reñasco | 11,5 | 1,0 | 2,0 | 14,5 | 18 | 14,0 |

Todas las cargas caben en las 18 h planificadas para las tres semanas de referencia (6 h × 3). La última columna reparte el ritmo observado de cierre de horas estimadas del equipo en partes iguales (18 × 23,3 ÷ 30 ≈ 14,0 h). Es un supuesto de planificación, no lo que cada persona cerró. La autoría de los PR (sección 3) está concentrada, pero no permite medir el esfuerzo de cada persona. Con ese supuesto, todas las cargas planificadas (14,5 a 15,75 h) quedan sobre las 14 h, así que en el plan la brecha no depende de una sola persona.

### Opciones de recorte para E4

Son opciones para que el equipo decida:

| Opción | Tarjetas | Horas estimadas | Ahorro |
| --- | --- | --- | --- |
| Bajar las revisiones semanales a 0,25 h por persona | R08, R09, R10 | 7,5 | Hasta 3,75 h |
| Acotar la regresión y las pruebas de imágenes a los casos de riesgo | K049, K051 | 8,0 | Por estimar |
| Unir el manual de demo con el paquete técnico | K052, K057 | 7,0 | Por estimar |
| Reducir el alcance de incidencias | K043, K044, K045, K046 | 17,0 | Toca un RF; hay que acordarlo con el profesor |

## 7. Bloqueos y medidas

No encontramos una asignación específica para estas medidas en las fuentes revisadas. La última columna es lo que el equipo tiene que decidir.

| Riesgo | Evidencia | Medida propuesta | Por decidir |
| --- | --- | --- | --- |
| Worker de producción sin ciclo exitoso reciente | `/api/health` a las 16:33: `{"status":"ok","database":"ok","worker":"stopped"}`. `stopped` significa que no hay latido de un ciclo exitoso en los últimos 60 s; puede ser un proceso caído o un ciclo que falla. | Revisar logs, latido y configuración del worker antes de decidir un reinicio, y comprobar después con `ops:status` | Quién lo revisa (requiere acceso a Railway) |
| Producción atrasada respecto de `development` | `release.json` de producción indica el commit `968d825`. [#177](https://github.com/ClemoAcevedo/rescate/pull/177), con 26 archivos de código y la migración `1791900000000_lot-management.sql`, está solo en `development`. [#178](https://github.com/ClemoAcevedo/rescate/pull/178) también, pero solo agrega scripts y documentación de demo. | Hacer un release antes del freeze de E3 (01-11 23:59), o mostrar #177 en local | Si hacemos release |
| Demo que depende del worker | El guion de #178 es en producción; los pasos 3 y 4 usan avisos, y publicar con foto necesita la validación del worker | Revisar el worker antes de la demo, o hacerla en local, como permite la pauta | Dónde se hace la demo |
| No encontramos SCA ni SAST | Lo pide la pauta de E3; `.github/workflows` solo tiene `ci.yml`, `deploy.yml` y `gemini-review.yml` | Ejecutar SCA y SAST antes del freeze de E3, en CI o una vez con el resultado registrado; si no alcanza, decirlo como pendiente en la presentación | Quién y cuándo |
| Cierres con evidencia incompleta | K039 y K040 tienen PR integrado, pero #170 y las cinco sesiones siguen pendientes; D3 y K042 no registran el ensayo ni el envío, y se cerraron antes que K041 | Anotar la evidencia, indicar en K042 qué versión de K041 usó, o reabrir lo que falte | Qué cuenta como «revisión aceptada» |
| Sin horas reales | 76 de 77 tarjetas sin «Horas reales equipo» | Anotar las horas al cerrar cada tarjeta | Cómo las registramos |
| Disponibilidad hasta el 21-11 desconocida | Sección 6 | Que cada persona indique sus horas disponibles para S08 a S10 | Quién lo recoge |
| Brecha para E4 | Sección 6 | Opciones de recorte de la sección 6 | Qué recortes proponemos |

Sin un ciclo exitoso del worker, producción no valida ni limpia fotos, no genera avisos, no registra los vencimientos (la API igual trata como vencido lo que pasó su plazo) y no borra el texto de los chats cerrados hace más de 30 días.

## 8. De dónde salen las cifras

Los datos de GitHub y de producción salen de estos comandos de lectura, ejecutados al corte:

```sh
gh issue list --state all --limit 300 --json number,title,state,closedAt,body,labels
gh project item-list 2 --owner ClemoAcevedo --format json --limit 300
gh pr list --state all --limit 300 --json number,title,author,createdAt,mergedAt,baseRefName,headRefName,reviews,state
gh run list --workflow "CI K006" --limit 400 --json conclusion
gh run list --workflow "Deploy production" --limit 100 --json conclusion,createdAt,databaseId,headSha
gh api repos/ClemoAcevedo/rescate/rulesets/23330702
gh api repos/ClemoAcevedo/rescate/branches/main --jq .protection   # checks obligatorios; igual para development
gh api repos/ClemoAcevedo/rescate/issues/45/events   # quién cerró y a qué hora
curl -s https://rescate-rescate1.vercel.app/api/health
curl -s https://rescate-rescate1.vercel.app/release.json
```

Criterios:

- Una tarjeta es un issue cuyo título parte con K###, D#, R## o P#. Las horas, la semana y el responsable salen de sus tablas «Planificación» y «Esfuerzo estimado».
- La semana de cierre se calcula con el `closedAt` del issue en hora de Chile (UTC−3). S01 parte el 14-09.
- Un PR de producto es un PR integrado que no es release ni sincronización de `main` (base o rama `main`, o título con «sincronizar main»).
- Un PR es de una tarjeta si tiene K### en el título o en la rama.
- La aprobación humana es una revisión `APPROVED` de una persona; los bots no cuentan.
- El p90 se calcula por rango más cercano.

## 9. Lo que no sabemos

- Cuántas horas trabajamos de verdad: solo K031 tiene horas reales.
- Si el ensayo D3 y el envío de K042 ocurrieron: los issues están cerrados como completados, pero no lo registran.
- Si se hicieron las cinco sesiones con personas de K040.
- Por qué el worker no registra ciclos exitosos: no revisamos Railway, y `/api/health` no distingue un proceso caído de un ciclo que falla.
- Dónde se hará la demo: el guion es en producción y la pauta permite hacerla en local.
- Cuántas horas podemos trabajar de verdad hasta el freeze: las 6 h por persona son una planificación inicial, no una disponibilidad confirmada.
- Cuánto pesan los 10 PR de S07 sin tarjeta y los 9 issues sin estimar.
- Cómo termina S07: la semana cierra el 01-11 a las 23:59 y estas cifras pueden cambiar.
