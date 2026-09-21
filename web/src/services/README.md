# Servicios

Esta carpeta contiene tipos preliminares y utilidades de comunicación con la API.

- `api-types.ts` contiene los tipos propuestos para identidad y lotes.
- `http-client.ts` se usa en la comprobación técnica `/health`; no integra operaciones de negocio ni gestión de credenciales.
- Al integrarlo, cada respuesta con datos debe proporcionar un parser que valide su forma en tiempo de ejecución.
- El [antecedente K004](../../../docs/contrato-api.md) conserva las propuestas y decisiones pendientes; no es un contrato definitivo.
- La [arquitectura S02](../../../docs/arquitectura/arquitectura.md) establece OpenAPI como contrato HTTP versionado al adoptarse. Los tipos HTTP se derivarán de él y se consolidarán los catálogos preliminares de esta carpeta y `../types/api.ts`, sin fuentes manuales paralelas. Todavía no se implementa esa generación.
