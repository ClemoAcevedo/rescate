# Documentación

## Arquitectura y desarrollo S02

- [Arquitectura actual y objetivo incremental S02](arquitectura/arquitectura.md).
  Diagramas separados, cuatro responsabilidades (HTTP, Application, Domain,
  Infrastructure), Composition, reglas de dependencia, transacciones, errores,
  contratos y propuesta de evidencia trazable para E2. El objetivo no se presenta
  como código ya implementado.
- [ADR 0003: arquitectura incremental del backend](adr/0003-arquitectura-incremental-s02.md).
  Decisión adoptada después de S01, antes de K008/K010, sin implementar esas tarjetas.
- [Reglas de desarrollo para agentes](../AGENTS.md).
- [Propuesta de contrato K004](contrato-api.md). Antecedente, no contrato definitivo:
  OpenAPI será el contrato HTTP versionado al adoptarse en S02; todavía no existe.

## Entorno local y evidencia S01

- [Desarrollo local y CI K006](desarrollo-local.md).
- [Verificación del entorno K006](verificacion-k006.md).

Los registros de cada tarjeta conservan el contexto de su ejecución original.
Para el estado integrado actual consultar la arquitectura y el código enlazado;
un pendiente histórico no implica que S01 siga sin integrar.

## Decisiones de dominio posteriores a E1

- [ADR 0002: ofertas parciales y resolución de la solicitud](adr/0002-ofertas-parciales.md).
  Referencia vigente para esta regla: reemplaza la espera obligatoria por cantidad
  completa y conserva FIFO. Aceptar, rechazar o dejar vencer resuelve la solicitud
  sin prioridad residual; volver a solicitar exige reingreso explícito. Incluye trazabilidad, inventario, recorrido e
  impacto futuro; no describe funcionalidad implementada.

## K005 — Fotos

- [Evaluación y prototipo de almacenamiento](k005-fotos.md)
- [Evidencia de ejecución y bloqueos](k005-evidencia.md)
## Migraciones y modelo

- [Migraciones: configuración, comandos y verificación de K002](migraciones.md).
- [ADR 0001: elección del gestor de migraciones](adr/0001-gestor-de-migraciones.md).
- [Modelo inicial K003: fuentes, entidades y decisiones](modelo-inicial.md).
- [K003: evidencia real y reproducción](k003-evidencia.md).

## E1

La documentación correspondiente a la primera entrega se encuentra en `entregas/e1`.

- [Informe E1](entregas/e1/informe-e1.pdf).
- [Anexos E1](entregas/e1/anexos-e1.pdf).

Estos documentos contienen los requerimientos, decisiones y contexto utilizados como base para la implementación.
Son artefactos históricos y no se reescriben con decisiones posteriores. Para
ofertas parciales prevalece ADR 0002 en el alcance que declara; las demás reglas
se conservan y los puntos pendientes no se consideran decididos.

## Publicación de lotes

Las decisiones, el contrato HTTP y las pruebas de la publicación de lotes están en
[k010-publicacion-lotes.md](k010-publicacion-lotes.md).
