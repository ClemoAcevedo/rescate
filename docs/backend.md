# Backend: punto de entrada

Este índice orienta la lectura del backend; los documentos de cada área mantienen
las decisiones y procedimientos completos. El resumen de lo implementado está en el
[README](../README.md#estado-actual).

[app.ts](../api/src/app.ts) monta `GET /health` y los routers de cada módulo;
[index.ts](../api/src/index.ts) y [worker.ts](../api/src/worker.ts) son las entradas
de los dos procesos, y [composition.ts](../api/src/composition.ts) los ensambla.
La [arquitectura](arquitectura/arquitectura.md) describe módulos, capas, worker y
despliegue.

## Documentación por tarea

| Para… | Leer |
| --- | --- |
| Entender módulos, capas y reglas de dependencia | [Arquitectura](arquitectura/arquitectura.md) y [ADR 0003](adr/0003-arquitectura-incremental-s02.md) |
| Implementar o consumir contratos HTTP | [Guía HTTP](api/README.md) y [OpenAPI](api/openapi.yaml) |
| Consultar tablas, estados y restricciones | [Modelo de datos](modelo-inicial.md) |
| Crear, probar o revertir migraciones | [Migraciones](migraciones.md) y [ADR 0001](adr/0001-gestor-de-migraciones.md) |
| Identidad, sesiones y consentimiento | [Identidad](k008-identidad.md) y [ADR 0009](adr/0009-consentimiento-del-correo.md) |
| Lotes, gestión posterior y búsqueda | [Lotes](lotes.md) |
| Fotos y almacenamiento de objetos | [Fotos](fotos.md) y [ADR 0005](adr/0005-ciclo-de-fotos.md) |
| Reservas, código de retiro y entregas | [Reservas](reservas.md) |
| Cola FIFO y ofertas parciales | [Cola de espera](cola-de-espera.md), [ADR 0002](adr/0002-ofertas-parciales.md) y [ADR 0010](adr/0010-cola-fifo-y-ofertas.md) |
| Vencimientos y el worker | [Vencimientos](vencimientos.md) y [arquitectura](arquitectura/arquitectura.md#worker) |
| Avisos, chat e incidencias | [Avisos](avisos.md), [chat](chat.md) e [incidencias](incidencias.md) |
| Límites de intentos, aislamiento por objeto y registros sin secretos | [Seguridad](seguridad.md) |
| Salud, revisión diaria, copias y restauración | [Operación](operacion.md) |
| Levantar el entorno y ejecutar checks | [Entorno local y CI](desarrollo-local.md) |
| Desplegar y operar releases | [Despliegue](despliegue.md) |

Antes de ampliar el backend, revisar arquitectura, ADR aplicables, modelo y
contrato. OpenAPI determina HTTP; las migraciones, la persistencia. Consultar
[AGENTS.md](../AGENTS.md) para las reglas de desarrollo y el
[frontend](../web/README.md) para el otro lado del contrato.

El [informe E1](entregas/e1/informe-e1.pdf) y sus [anexos](entregas/e1/anexos-e1.pdf)
son históricos; los ADR posteriores prevalecen en las reglas que modifican.
