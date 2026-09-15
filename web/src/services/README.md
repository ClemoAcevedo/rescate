# Servicios

Esta carpeta concentra contratos, tipos y utilidades de comunicación con la API.

- `api-types.ts` contiene los tipos propuestos para identidad y lotes.
- `http-client.ts` es un cliente HTTP sin integración funcional ni gestión de credenciales.
- Al integrarlo, cada respuesta con datos debe proporcionar un parser que valide su forma en tiempo de ejecución.
- El contrato y las decisiones pendientes están documentados en `../../docs/contrato-api.md`.
