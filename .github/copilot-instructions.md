# Revisión de pull requests

Responde en español. Sigue las reglas y referencias de [AGENTS.md](../AGENTS.md).
Señala defectos introducidos por el cambio con un archivo, una línea y un caso
concreto que explique su impacto. Prioriza errores de comportamiento, seguridad,
integridad de datos y regresiones sobre preferencias de estilo.

- Comprueba autorización con el actor autenticado y los permisos actuales; un UUID
  público o un control oculto en la web no concede acceso.
- Revisa los límites HTTP, Application, Domain e Infrastructure mediante imports
  y llamadas reales. OpenAPI es la fuente del contrato HTTP.
- En reservas, cancelaciones y ofertas, comprueba bloqueo del lote, atomicidad,
  idempotencia, inventario y límites de tiempo con el reloj de PostgreSQL.
- Conserva migraciones compartidas e historial; un cambio de esquema necesita
  una nueva migración compatible con los datos existentes.
- En la web, comprueba estados de carga/error, accesibilidad y reutilización de
  los primitives y tokens existentes.
- Contrasta las afirmaciones del PR con el código y la evidencia. Distingue
  comprobaciones ejecutadas de pruebas sugeridas; no inventes resultados.

Los comandos y requisitos de validación están en
[Entorno local y CI](../docs/desarrollo-local.md#los-mismos-checks-que-ci).
Las reglas de negocio se documentan por área en [docs/README.md](../docs/README.md).
