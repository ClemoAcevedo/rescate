# Documentación

Estado de integración: K008 (`23549d6`) con K010 y el design system, más la
documentación conceptual K013 de `origin/development` (`91172ea`).
La integración está pendiente de merge commit; no se acredita una nueva ejecución
de CI remoto ni un despliegue.

## Empezar por área

| Necesidad | Guía |
| --- | --- |
| Trabajar en frontend | [Estructura, rutas y checks](../web/README.md) |
| Reutilizar diseño en esta rama | [Primitives UI](../web/src/components/ui/README.md) y [comparación/decisiones de integración](frontend-design-system.md) |
| Trabajar en backend | [Punto de entrada al backend](backend.md) |
| Ejecutar el proyecto | [Entorno local y CI](desarrollo-local.md) |
| Reglas del repositorio | [AGENTS.md](../AGENTS.md) |

## Referencias vigentes

- [Arquitectura actual y objetivo incremental S02](arquitectura/arquitectura.md):
  responsabilidades, dependencias, transacciones y evidencia esperada; el objetivo
  no equivale a funcionalidades implementadas.
- [Guía del contrato HTTP](api/README.md) y [OpenAPI S02](api/openapi.yaml):
  autoridad HTTP para K008–K011; K010 implementa lotes y K008 identidad/seguridad.
- [Modelo inicial K003](modelo-inicial.md): persistencia integrada y diferencias
  con el contrato posterior; incluye el modelo conceptual y estados E2 de K013.
  [Casos de uso de dominio](casos-de-uso.md) y [trazabilidad/pendientes K013](k013-trazabilidad.md)
  cubren el objetivo E2 sin declarar integración futura. [Migraciones](migraciones.md):
  operación actual K003 y aceptación histórica K002 separadas.
- [Fotos K005](k005-fotos.md): guía del prototipo aislado. La investigación de
  proveedores y los resultados allí fechados son históricos, no una nueva evaluación.

- [Identidad y sesiones K008](k008-identidad.md): implementación, decisiones, operación HTTPS y evidencia.
- [Publicación de lotes K010](k010-publicacion-lotes.md): implementación y límites de integración.

## Decisiones (ADR)

| ADR | Decisión vigente |
| --- | --- |
| [0001](adr/0001-gestor-de-migraciones.md) | node-pg-migrate, SQL y pg |
| [0002](adr/0002-ofertas-parciales.md) | FIFO, oferta parcial y cierre al aceptar/rechazar/vencer, sin prioridad residual ni reingreso automático |
| [0003](adr/0003-arquitectura-incremental-s02.md) | Arquitectura incremental HTTP, Application, Domain e Infrastructure; Composition ensambla |

## Evidencia y antecedentes

Los registros conservan su contexto original. Un resultado histórico no demuestra
un nuevo run y un pendiente histórico no describe por sí solo el estado integrado
actual. El contexto de los ADR también corresponde a la fecha de cada decisión.

- [Evidencia K002](migraciones.md#evidencia-de-esta-implementación-2026-09-20).
- [Evidencia K003](k003-evidencia.md).
- [Evidencia K005](k005-evidencia.md).
- [Evidencia K010](k010-evidencia.md).
- [Evidencia K006](verificacion-k006.md).
- [Propuesta de contrato K004](contrato-api.md): conservada como antecedente;
  sustituida como autoridad HTTP por OpenAPI S02.
- [Evidencia de integración visual](frontend-design-system.md#verificación-ejecutada):
  comprobaciones locales de esta rama, no funcionalidades K009/K011.

## Entrega E1

[Informe](entregas/e1/informe-e1.pdf) y [anexos](entregas/e1/anexos-e1.pdf)
contienen los requisitos, decisiones y contexto originales. No se reescriben.
Los ADR posteriores prevalecen solo sobre las reglas que modifican explícitamente;
los demás requisitos y pendientes se conservan.
