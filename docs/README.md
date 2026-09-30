# Documentación

El estado del proyecto está en el [README](../README.md#estado-actual). Las
reglas para escribir y mantener estos documentos están en [AGENTS.md](../AGENTS.md#documentación).

## Por área

| Área | Documento |
| --- | --- |
| Levantar el proyecto y CI | [Entorno local y CI](desarrollo-local.md) |
| Producción y releases | [Despliegue Railway/Vercel](despliegue.md) |
| Arquitectura y capas | [Arquitectura](arquitectura/arquitectura.md) y [punto de entrada al backend](backend.md) |
| Contrato HTTP | [OpenAPI S02](api/openapi.yaml) y [su guía](api/README.md) |
| Dominio y requisitos | [Modelo](modelo-inicial.md), [casos de uso](casos-de-uso.md) y [trazabilidad](k013-trazabilidad.md) |
| Identidad y sesiones | [Identidad](k008-identidad.md) |
| Lotes | [Lotes](lotes.md) |
| Fotos | [Prototipo de fotos](k005-fotos.md) |
| Base de datos | [Migraciones](migraciones.md) |
| Frontend | [web/README](../web/README.md), [primitives UI](../web/src/components/ui/README.md) y [design system](frontend-design-system.md) |

## Decisiones (ADR)

| ADR | Decisión vigente |
| --- | --- |
| [0001](adr/0001-gestor-de-migraciones.md) | node-pg-migrate, SQL y pg |
| [0002](adr/0002-ofertas-parciales.md) | FIFO, oferta parcial y cierre al aceptar/rechazar/vencer, sin prioridad residual ni reingreso automático |
| [0003](adr/0003-arquitectura-incremental-s02.md) | Arquitectura incremental HTTP, Application, Domain e Infrastructure; Composition ensambla |
| [0004](adr/0004-reserva-directa-idempotente.md) | Reserva directa e idempotencia por actor, resultado persistido y bloqueo de lote |

## Entregas y evidencia

- [Informe E1](entregas/e1/informe-e1.pdf) y [anexos E1](entregas/e1/anexos-e1.pdf):
  requisitos originales. No se reescriben; los ADR posteriores prevalecen solo en lo
  que modifican.
- [Evidencia](evidencia/): registros de ejecución de K003, K005, K006, K009 y K010,
  conservados como estaban. La evidencia nueva va en la descripción del PR y en CI.
