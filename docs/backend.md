# Backend: punto de entrada

Referencia de implementación: K008 integrado con K010 en el árbol de trabajo, 2026-09-21. Este índice orienta la lectura; los documentos especializados
mantienen las decisiones y procedimientos completos.

## Estado implementado

[app.ts](../api/src/app.ts) conserva `GET /health` y monta las cuatro operaciones
[de lotes K010](k010-publicacion-lotes.md). [Composition](../api/src/composition.ts)
ensambla Pool, repositorio, casos de uso y HTTP. La salud no consulta PostgreSQL
ni B2. [K008](k008-identidad.md) incorpora las cuatro operaciones auth, scrypt,
sesiones persistentes, cookies, origen/CSRF y Actor real. No hay actor temporal
en runtime ni reservas.
El [worker](../api/src/worker.ts) sigue inactivo y [K005](k005-fotos.md) es una CLI aislada.

## Documentación vigente por tarea

| Para… | Leer |
| --- | --- |
| Entender estado actual y arquitectura objetivo | [Arquitectura](arquitectura/arquitectura.md) y [ADR 0003](adr/0003-arquitectura-incremental-s02.md) |
| Implementar o consumir contratos HTTP S02 | [Guía HTTP](api/README.md) y [OpenAPI](api/openapi.yaml); lotes e identidad implementados; pantallas web de negocio pendientes |
| Entender identidad, atomicidad y seguridad | [K008](k008-identidad.md) |
| Levantar el entorno y ejecutar checks | [Entorno local y CI](desarrollo-local.md) |
| Consultar persistencia y operar migraciones | [Modelo K003](modelo-inicial.md), [guía de migraciones](migraciones.md) y [ADR 0001](adr/0001-gestor-de-migraciones.md) |
| Interpretar FIFO y ofertas parciales | [ADR 0002](adr/0002-ofertas-parciales.md), decisión vigente sin implementación del flujo |
| Repetir el prototipo local/B2 | [Guía K005](k005-fotos.md); no es un endpoint ni pipeline de imágenes |

Antes de ampliar backend, revisar arquitectura, ADR aplicables, modelo y contrato.
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
