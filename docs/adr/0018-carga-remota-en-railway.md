# ADR 0018: carga remota hacia Railway

## Contexto

El anexo H de E1 propone un servidor y otro computador en la misma LAN. La
aplicación se despliega en Railway y el equipo dispone de un computador para
generar carga. Ejecutar todo en la VM local mezcla el costo del servidor con el
del generador y, en algunos equipos, con la emulación de PostGIS.

## Decisión

Se incorpora un escenario remoto: k6 en el computador del evaluador accede por
HTTPS a una API en Railway, con worker y PostgreSQL/PostGIS en su red privada.
Se usa un entorno dedicado `carga-e3`, o un nombre con ese prefijo, con volumen,
base y claves propios. Cada ensayo crea y migra una base vacía, restaura la misma
escala y despliega API y worker del código local contra ella.

Se mantienen tres ensayos de 120 s de preparación y 600 s medidos, la mezcla E3
de 20 solicitudes/s, los umbrales y las invariantes del anexo. Se publican
percentiles por ensayo, configuración y métricas del proveedor. Las sesiones de
la semilla se conservan solo en archivos privados.

## Consecuencias

El escenario mide el servicio desplegado junto con la latencia de Internet. El
generador queda separado del servidor; la variación de red forma parte del
resultado. Las cuotas de CPU y RAM de Railway se registran como límites por
servicio. La memoria disponible del host, el disco físico y la ausencia de
emulación requieren evidencia propia: una cuota del proveedor no los prueba.

Este escenario reemplaza la LAN para la evaluación cloud elegida por el equipo.
La configuración del proveedor y sus muestras de consumo sustituyen la inspección
del equipo físico en este escenario. El informe identifica esa diferencia respecto
del protocolo original de #170 y conserva las fallas de cualquier ensayo.

Se conserva el ejecutor Compose y su generador por SSH para reproducir el
protocolo LAN. Se descarta sembrar producción: la escala y las escrituras de
carga requieren datos ficticios y aislamiento verificable.
