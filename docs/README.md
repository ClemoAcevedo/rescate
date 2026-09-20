# Documentación

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

- `informe-e1.pdf`
- `anexos-e1.pdf`

Estos documentos contienen los requerimientos, decisiones y contexto utilizados como base para la implementación.
Son artefactos históricos y no se reescriben con decisiones posteriores. Para
ofertas parciales prevalece ADR 0002 en el alcance que declara; las demás reglas
se conservan y los puntos pendientes no se consideran decididos.
