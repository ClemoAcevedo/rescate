# ADR 0014: cupo de lecturas por usuario

Estado: adoptada en el cierre de S06. Modifica la fila «API autenticada» de anexos H
p. 21 («120 solicitudes por minuto y usuario, con ráfaga de 20»), aplicada en K034
([seguridad](../seguridad.md)).

## Contexto

El panel del establecimiento (K035) lee el panel, los compromisos y el historial por
separado. Una carga completa cuesta entre tres y cinco solicitudes con la sesión y los
avisos, cambiar el período cuesta tres y filtrar por lote, dos. Con un único cupo de 20,
un operador que recarga y cambia filtros con rapidez recibe 429 en compromisos e
historial. Lo confirmó `test:web:panel` al recargar el panel y corregir el período,
sin ningún uso anómalo.

## Decisión

El límite por usuario se cobra al resolver la sesión, en dos cupos independientes en
memoria del proceso:

- **Lecturas** (GET y HEAD): 300 solicitudes por minuto, ráfaga de 60.
- **Escrituras** (el resto de los métodos): 120 por minuto, ráfaga de 20, como fija H p. 21.

Agotar uno no consume el otro. El límite por IP (3000/min, ráfaga 100) y los límites
de login, códigos de retiro y mensajes no cambian.

## Alternativas descartadas

- **Subir el límite general.** También afloja las escrituras (reservas, cancelaciones,
  confirmaciones), que son las que cambian inventario y merecen el cupo más estricto.
- **Un solo endpoint con panel, compromisos e historial.** Baja las solicitudes por
  carga, pero cambia el contrato OpenAPI, acopla paginaciones independientes y obliga a
  releer todo al cambiar un filtro.
- **Mantener el cupo y documentar el riesgo.** El 429 aparece con navegación normal y
  rápida del operador, no solo con abuso.

## Consecuencias

Un usuario puede leer hasta 300 veces por minuto. Las lecturas son consultas acotadas y
paginadas: a escala, el panel tarda de 1 a 17 ms y el historial ~100 ms en PostgreSQL
([rendimiento](../rendimiento.md)). Sigue el límite por IP como techo por origen. Las
escrituras conservan la protección de E1. Como el resto de los límites en memoria, los
cupos se reinician con la API y se multiplican si hay varias instancias.
