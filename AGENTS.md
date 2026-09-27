# Desarrollo de Rescate

## Referencias y alcance

Antes de implementar backend, revisar la [arquitectura](docs/arquitectura/arquitectura.md),
[ADR 0003](docs/adr/0003-arquitectura-incremental-s02.md), el
[modelo inicial](docs/modelo-inicial.md) y los ADR aplicables.
Separar siempre estado implementado de objetivo. El estado actual está en la
sección «Estado actual» del [README](README.md#estado-actual).

Aplicar estas reglas al código nuevo de S02 de manera incremental. Crear archivos
y carpetas cuando tengan una responsabilidad real. No mover código existente solo
para ajustarlo al árbol propuesto ni añadir frameworks o abstracciones sin necesidad.

## Límites del backend

- HTTP conoce Express, DTO, parsing estructural, cookies y Application. Mantener
  handlers ligeros, sin SQL, pg, SDK B2/S3 ni reglas centrales de negocio.
- Application coordina casos de uso, autorización y atomicidad usando Domain,
  actor autenticado, tipos propios y ports necesarios. No recibe req/res ni cookies
  concretas; no importa Express, pg o adaptadores concretos de Infrastructure.
- Domain contiene reglas puras. No depende de HTTP, Application, Infrastructure,
  SQL, entorno, almacenamiento ni filesystem. Preferir funciones si bastan.
- Infrastructure implementa ports con PostgreSQL, criptografía, sesiones y objetos.
  No decide quién está autorizado ni qué transición permite el negocio.
- Composition lee configuración y ensambla Pool, adaptadores, casos de uso y
  entradas HTTP/worker. No es una quinta capa de negocio ni un contenedor de DI.
- Application define la unidad atómica; Infrastructure ejecuta BEGIN/COMMIT/ROLLBACK
  con el mismo cliente. No exponer clientes pg mediante ports ni diseñar por
  anticipado un framework genérico de Unit of Work.
- Worker reutiliza casos de uso cuando tenga trabajos reales; no duplica políticas
  ni llama a la API HTTP local. No realizar llamadas externas bajo bloqueo de lote.
- Domain/Application expresan errores semánticos; HTTP los traduce según contrato.
  Infrastructure no elige códigos HTTP. No filtrar detalles internos en respuestas.

## Contratos, persistencia y decisiones

[OpenAPI S02](docs/api/openapi.yaml) es la fuente de verdad HTTP versionada;
[su guía](docs/api/README.md) documenta decisiones y validación. K008/K010 incorporan
handlers y tipos HTTP generados (`npm --prefix api run api:types`); no mantener catálogos manuales paralelos.
OpenAPI no define el esquema SQL ni sustituye las reglas de Domain/documentación.

Mantener node-pg-migrate y SQL según [ADR 0001](docs/adr/0001-gestor-de-migraciones.md).
No reescribir migraciones compartidas ya aplicadas; los cambios de esquema futuros
requieren una nueva migración dentro de la tarjeta que los necesite.
Conservar [ADR 0002](docs/adr/0002-ofertas-parciales.md): FIFO, oferta parcial y
cierre al aceptar/rechazar/vencer sin prioridad residual ni reingreso automático.
Los PDF de E1 son históricos; registrar decisiones posteriores sin reescribirlos.

## Frontend compartido

Antes de trabajar en `web/`, revisar los [primitives UI](web/src/components/ui/README.md)
y reutilizar los [tokens](web/src/styles/tokens.css). Evitar componentes equivalentes
duplicados y colores/espaciados arbitrarios cuando exista un token. Adaptar el
material externo al stack local; no copiarlo directamente. Los componentes UI no
definen contratos HTTP: sigue prevaleciendo OpenAPI S02.

## Documentación

La documentación se organiza por área del sistema, no por tarjeta. El
[índice](docs/README.md) lista un documento por área.

- **Actualizar, no crear.** Cada PR actualiza el documento del área que cambia
  (por ejemplo [lotes](docs/lotes.md)). No crear un documento por tarjeta. Crear un
  documento solo para un área nueva y agregarlo al índice.
- **Presente, sin fotos del estado.** Describir cómo funciona el sistema hoy. No
  escribir fechas, commits, ramas ni frases como «pendiente de merge» o «en el
  árbol de trabajo». El resumen de estado vive solo en el README y se actualiza en
  el PR que lo cambia.
- **Cada cosa en su lugar.** La evidencia de ejecución va en la descripción del PR
  y en CI, no en `docs/`. Una decisión con alternativas descartadas va en un ADR.
  Un pendiente o deuda técnica va en un issue, y el documento lo enlaza (#NN).
- **Breve y directo.** Explicar lo que el código no dice: reglas, decisiones y
  cómo probar. No repetir OpenAPI, el esquema SQL ni el código. Afirmar lo que es;
  evitar descargos como «no se afirma» o «no se acredita».
- **Borrar lo reemplazado.** Si un documento o sección queda obsoleto, eliminarlo;
  el historial de git lo conserva. No mantener antecedentes en paralelo.
- **Contrastar con la fuente.** Antes de declarar un requisito como no definido,
  buscarlo en los PDF de E1 (no son buscables como texto; extraer el texto primero).

## Revisión y evidencia

Relacionar decisiones con archivos y pruebas reales en cada PR. Revisar imports,
autorización, transacciones y mapeo de errores; no basta con nombres de carpetas.
Ejecutar checks pertinentes al cambio y distinguir evidencia histórica de pruebas
nuevas. Para documentación: comprobar enlaces, Mermaid cuando exista,
`git diff --check`, marcadores de conflicto y alcance del diff. No presentar
funcionalidades futuras ni procesos vivos como pruebas de un caso de uso completo.
