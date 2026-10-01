# Backend: punto de entrada

Este índice orienta la lectura del backend; los documentos de cada área mantienen
las decisiones y procedimientos completos.

## Estado implementado

[app.ts](../api/src/app.ts) conserva `GET /health` y monta las cuatro operaciones
[de lotes K010](lotes.md). [Composition](../api/src/composition.ts)
ensambla Pool, repositorio, casos de uso y HTTP. La salud no consulta PostgreSQL
ni B2. [K008](k008-identidad.md) incorpora las cuatro operaciones auth, scrypt,
sesiones persistentes, cookies, origen/CSRF y Actor real. No hay actor temporal
en runtime. K015 añade búsqueda PostGIS y reserva directa bajo bloqueo;
[ADR 0004](adr/0004-reserva-directa-idempotente.md) define sus reintentos.
K014 agrega carga, lectura y retiro de [fotos](fotos.md); el [worker](../api/src/worker.ts)
las valida y limpia objetos con los mismos casos de uso de Application.

## Documentación vigente por tarea

| Para… | Leer |
| --- | --- |
| Entender estado actual y arquitectura objetivo | [Arquitectura](arquitectura/arquitectura.md) y [ADR 0003](adr/0003-arquitectura-incremental-s02.md) |
| Implementar o consumir contratos HTTP S02 | [Guía HTTP](api/README.md) y [OpenAPI](api/openapi.yaml) |
| Trabajar en lotes | [Lotes](lotes.md) |
| Entender identidad, atomicidad y seguridad | [K008](k008-identidad.md) |
| Levantar el entorno y ejecutar checks | [Entorno local y CI](desarrollo-local.md) |
| Desplegar web/API y operar releases | [Railway, Vercel y CD](despliegue.md) |
| Consultar persistencia y operar migraciones | [Modelo K003](modelo-inicial.md), [guía de migraciones](migraciones.md) y [ADR 0001](adr/0001-gestor-de-migraciones.md) |
| Interpretar FIFO y ofertas parciales | [ADR 0002](adr/0002-ofertas-parciales.md), decisión vigente sin implementación del flujo |
| Trabajar en fotos, el worker o el bucket B2 | [Fotos](fotos.md) y [ADR 0005](adr/0005-ciclo-de-fotos.md) |

Antes de ampliar backend, revisar arquitectura, ADR aplicables, modelo y contrato.
OpenAPI determina HTTP; el modelo/SQL determina persistencia. La UI no cambia
ninguna de esas autoridades. Consultar [AGENTS.md](../AGENTS.md) para las reglas
de desarrollo y [frontend](../web/README.md) para el otro lado del contrato.

## Antecedentes y evidencia histórica

- [Evidencia K002](migraciones.md#evidencia-de-esta-implementación-2026-09-20),
  [K003](evidencia/k003.md), [K005](evidencia/k005.md) y [K006](evidencia/k006.md):
  resultados de sus ejecuciones originales, no pruebas recién ejecutadas.
- [Informe E1](entregas/e1/informe-e1.pdf) y [anexos](entregas/e1/anexos-e1.pdf):
  artefactos históricos conservados; los ADR posteriores prevalecen únicamente
  en las reglas que modifican expresamente.

El contexto histórico de un ADR o una evidencia puede describir una rama anterior.
Para el estado integrado usar las referencias vigentes y el código enlazado arriba.
