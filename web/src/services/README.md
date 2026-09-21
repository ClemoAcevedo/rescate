# Servicios

Esta carpeta contiene tipos preliminares y utilidades de comunicación con la API.

- `api-types.ts` contiene tipos históricos de K004; no deben usarse como contrato S02.
- `http-client.ts` se usa en la comprobación técnica `/health`; no integra operaciones de negocio ni gestión de credenciales.
- Al integrarlo, cada respuesta con datos debe proporcionar un parser que valide su forma en tiempo de ejecución.
- El [antecedente K004](../../../docs/contrato-api.md) conserva las propuestas y decisiones pendientes; no es un contrato definitivo.
- [OpenAPI S02](../../../docs/api/openapi.yaml) es la fuente de verdad HTTP.
  Su [guía](../../../docs/api/README.md) documenta validación, sesión, CSRF y decisiones.
  K009/K011 derivarán los tipos desde él y sustituirán/consolidarán los catálogos
  preliminares de esta carpeta y `../types/api.ts`, sin fuentes manuales paralelas.
  Todavía no se implementan generación ni consumidores de negocio.
