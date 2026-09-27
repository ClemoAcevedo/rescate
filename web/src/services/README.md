# Servicios

Esta carpeta contiene tipos preliminares y utilidades de comunicación con la API.

- `api-types.ts` contiene tipos históricos de K004; no deben usarse como contrato S02.
- `http-client.ts` se usa en la comprobación técnica `/health`; no integra operaciones de negocio ni gestión de credenciales.
- Al integrarlo, cada respuesta con datos debe proporcionar un parser que valide su forma en tiempo de ejecución.
- El [antecedente K004](../../../docs/contrato-api.md) conserva las propuestas y decisiones pendientes; no es un contrato definitivo.
- [OpenAPI S02](../../../docs/api/openapi.yaml) es la fuente de verdad HTTP.
  Su [guía](../../../docs/api/README.md) documenta validación, sesión, CSRF y decisiones.
- `openapi.ts` se genera desde el YAML con `npm --prefix api run api:types`
  (misma salida que la API; `api:types:check` verifica ambas en CI). No editar a mano.
- `lots-service.ts` (K011) usa esos tipos y valida `LotResponse` en runtime.
  `identity-service.ts` (K009) aún declara sus tipos a mano: deuda registrada en
  [K011](../../../docs/k011-formulario-lotes.md#deuda-técnica-registrada), al igual que
  los catálogos preliminares de esta carpeta y `../types/api.ts`.
