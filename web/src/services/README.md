# Servicios

Esta carpeta contiene los servicios que consumen la API y sus tipos.

- `api-types.ts` contiene tipos históricos de K004; no deben usarse como contrato S02.
- `http-client.ts` hace las solicitudes; cada respuesta con datos debe proporcionar un parser que valide su forma en tiempo de ejecución.
- [OpenAPI S02](../../../docs/api/openapi.yaml) es la fuente de verdad HTTP.
  Su [guía](../../../docs/api/README.md) documenta validación, sesión, CSRF y decisiones.
- `openapi.ts` se genera desde el YAML con `npm --prefix api run api:types`
  (misma salida que la API; `api:types:check` verifica ambas en CI). No editar a mano.
- `lots-service.ts` (K011) usa esos tipos y valida `LotResponse` en runtime.
  `identity-service.ts` (K009) aún declara sus tipos a mano; unificarlo y quitar
  `api-types.ts` y `../types/api.ts` sin uso está en #98.

- `discovery-service.ts` consulta lotes públicos y reserva con reintentos de la misma
  intención; `reservation-intent.ts` conserva clave y cantidad en la pestaña.
- `reservations-service.ts` consulta historial/detalle y cancela con CSRF; valida
  estado, ventana y coherencia del código antes de entregar datos a la vista.
