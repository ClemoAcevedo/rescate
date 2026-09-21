# Desarrollo de Rescate

## Referencias y alcance

Antes de implementar backend, revisar la [arquitectura](docs/arquitectura/arquitectura.md),
[ADR 0003](docs/adr/0003-arquitectura-incremental-s02.md), el
[modelo inicial](docs/modelo-inicial.md) y los ADR aplicables.
Separar siempre estado implementado de objetivo. El backend actual solo expone
`/health`; el worker está inactivo y K005 es un prototipo aislado.

Aplicar estas reglas al código nuevo de S02 de manera incremental. Crear archivos
y carpetas cuando tengan una responsabilidad real. No mover código existente solo
para ajustarlo al árbol propuesto ni añadir frameworks o abstracciones sin necesidad.
Actualizar esta descripción cuando cambie la implementación.

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
[su guía](docs/api/README.md) documenta decisiones y validación. Aún no hay handlers
de negocio ni generación de tipos. Derivar de él los tipos HTTP al integrar
consumidores; no mantener catálogos manuales paralelos. [K004](docs/contrato-api.md)
y los tipos existentes quedan como antecedentes.
OpenAPI no define el esquema SQL ni sustituye las reglas de Domain/documentación.

Mantener node-pg-migrate y SQL según [ADR 0001](docs/adr/0001-gestor-de-migraciones.md).
No reescribir migraciones compartidas ya aplicadas; los cambios de esquema futuros
requieren una nueva migración dentro de la tarjeta que los necesite.
Conservar [ADR 0002](docs/adr/0002-ofertas-parciales.md): FIFO, oferta parcial y
cierre al aceptar/rechazar/vencer sin prioridad residual ni reingreso automático.
Los PDF de E1 son históricos; registrar decisiones posteriores sin reescribirlos.

## Revisión y evidencia

Relacionar decisiones con archivos y pruebas reales en cada PR. Revisar imports,
autorización, transacciones y mapeo de errores; no basta con nombres de carpetas.
Ejecutar checks pertinentes al cambio y distinguir evidencia histórica de pruebas
nuevas. Para documentación: comprobar enlaces, Mermaid cuando exista,
`git diff --check`, marcadores de conflicto y alcance del diff. No presentar
funcionalidades futuras ni procesos vivos como pruebas de un caso de uso completo.
