# Backend: punto de entrada

Referencia vigente: `development` `cb5ca3b`, comprobado contra `origin/development`
el 2026-09-21. Este índice orienta la lectura; los documentos especializados
mantienen las decisiones y procedimientos completos.

## Estado implementado

[app.ts](../api/src/app.ts) expone únicamente `GET /health`;
[index.ts](../api/src/index.ts) inicia Express. La salud no consulta PostgreSQL
ni B2. El [worker](../api/src/worker.ts) permanece inactivo. K002/K003 aportan
migraciones y modelo; [fotos K005](k005-fotos.md) es una CLI aislada.
No hay auth, publicación, reservas ni casos de uso de negocio implementados.

## Documentación vigente por tarea

| Para… | Leer |
| --- | --- |
| Entender estado actual y arquitectura objetivo | [Arquitectura](arquitectura/arquitectura.md) y [ADR 0003](adr/0003-arquitectura-incremental-s02.md) |
| Implementar o consumir contratos HTTP S02 | [Guía HTTP](api/README.md) y [OpenAPI](api/openapi.yaml); las operaciones están definidas, todavía no implementadas |
| Levantar el entorno y ejecutar checks | [Entorno local y CI](desarrollo-local.md) |
| Consultar persistencia y operar migraciones | [Modelo K003](modelo-inicial.md), [guía de migraciones](migraciones.md) y [ADR 0001](adr/0001-gestor-de-migraciones.md) |
| Interpretar FIFO y ofertas parciales | [ADR 0002](adr/0002-ofertas-parciales.md), decisión vigente sin implementación del flujo |
| Repetir el prototipo local/B2 | [Guía K005](k005-fotos.md); no es un endpoint ni pipeline de imágenes |

Antes de K008/K010, revisar arquitectura, ADR aplicables, modelo y contrato.
OpenAPI determina HTTP; el modelo/SQL determina persistencia. La UI no cambia
ninguna de esas autoridades. Consultar [AGENTS.md](../AGENTS.md) para las reglas
de desarrollo y [frontend](../web/README.md) para el otro lado del contrato.

## Antecedentes y evidencia histórica

- [K004](contrato-api.md): propuesta HTTP anterior; prevalece OpenAPI S02.
- [Evidencia K002](migraciones.md#evidencia-de-esta-implementación-2026-09-20),
  [K003](k003-evidencia.md), [K005](k005-evidencia.md) y [K006](verificacion-k006.md):
  resultados de sus ejecuciones originales, no pruebas recién ejecutadas.
- [Informe E1](entregas/e1/informe-e1.pdf) y [anexos](entregas/e1/anexos-e1.pdf):
  artefactos históricos conservados; los ADR posteriores prevalecen únicamente
  en las reglas que modifican expresamente.

El contexto histórico de un ADR o una evidencia puede describir una rama anterior.
Para el estado integrado usar las referencias vigentes y el código enlazado arriba.
