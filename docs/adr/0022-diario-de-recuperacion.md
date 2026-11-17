# ADR 0022: diario cifrado independiente para conciliar una recuperación

## Contexto

RNF08 exige conciliar los compromisos posteriores a una copia antes de reabrir
(anexos H p. 22; #207). La base restaurada y su outbox pierden esas mismas escrituras.
Los registros HTTP sin persona ni recurso tampoco identifican a los afectados,
especialmente si su cuenta nació después de la copia.

## Decisión

Guardar un diario privado en almacenamiento de objetos, fuera de PostgreSQL.
Application usa un port de recuperación; Infrastructure cifra con AES-256-GCM
y una clave distinta de la del respaldo, de los códigos de retiro y del proxy.

Cada publicación, gestión de inventario, reserva, cancelación, entrega, transición
de cola e incidencia prepara una intención antes de su unidad atómica. Después
del COMMIT guarda un resultado mínimo. El worker hace lo mismo por lote reclamado,
después de terminar el reclamo y antes de bloquear el lote. Ninguna llamada a
objetos ocurre bajo el bloqueo de negocio.

La intención contiene operación, identificadores, clave de intención y contacto
cifrado del actor. El resultado conserva solo identificadores, estado, cantidad,
versión e instantes. No guarda códigos de retiro, credenciales, sesiones, texto de
chat ni motivos de incidencias. Cada entorno tiene un prefijo independiente.

Si no se puede preparar, no empieza la escritura. Si falla la confirmación después
del COMMIT, la API devuelve 503; la intención permanece como resultado incierto.
Los comandos conservan sus reglas de idempotencia y autorización. El diario no
autoriza ni reproduce transiciones. Los errores técnicos nunca se interpretan
como prueba de rollback.

La conciliación consulta la base restaurada y el diario: excluye resultados ya
incluidos en la copia, enlaza compromisos con lotes y obtiene contactos del diario
y de la base. Un caso incierto o posterior exige decisión y evidencia de Operación
antes de declarar listo para reabrir. Una entrega perdida se contrasta con operador
y titular; no se reejecuta ni se reutiliza su código automáticamente.

La retención cubre la copia más antigua conservada y al menos ocho días. La rotación
solo ocurre después de verificar una copia completa. La clave se conserva aparte
del archivo cifrado; los informes descifrados tienen permisos 0600 y se eliminan
al terminar la intervención.

## Alternativas y consecuencias

- El outbox o una tabla de auditoría en la misma base se pierden con ella.
- Los identificadores en stdout dependen de la retención y exportación del proveedor,
  y no permiten contactar una cuenta ausente de la copia sin añadir su correo al log.
- WAL/PITR ofrece otra granularidad, pero requiere administrar archivado y recuperación
  física adicionales al PostgreSQL actual.

El diario añade dos escrituras de objetos por comando y vincula la disponibilidad
de esos comandos con el almacenamiento. Se acotan tiempos y reintentos; se mide su
latencia en el despliegue junto con la comprobación de RNF01. Las lecturas, el login,
el chat y los ciclos vacíos del worker no escriben en el diario. Cambiar la clave
requiere conservar las claves anteriores mientras sus registros sigan retenidos.
