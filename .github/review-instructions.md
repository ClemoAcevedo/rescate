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
  Sigue el recorrido después de un 4xx/5xx: los formularios deben permitir corregir
  entradas y los reintentos deben poder recuperar la operación.
- Contrasta las afirmaciones del PR con el código y la evidencia. Distingue
  comprobaciones ejecutadas de pruebas sugeridas; no inventes resultados.
- Cada hallazgo necesita un caso concreto y evidencia visible del código. Busca
  también validaciones que puedan refutarlo antes de publicarlo. Una dependencia
  sin definición disponible o una API recordada de otra versión no demuestra un bug.
- La cobertura es la del diff recibido y su contexto explícito. No des por revisados
  archivos omitidos ni conviertas la descripción del autor en una aprobación general.

Los comandos y requisitos de validación están en
[Entorno local y CI](../docs/desarrollo-local.md#los-mismos-checks-que-ci).
Las reglas de negocio se documentan por área en [docs/README.md](../docs/README.md).
