# Servicios

Esta carpeta contiene los servicios que consumen la API y sus tipos.

- `http-client.ts` hace las solicitudes; cada respuesta con datos debe proporcionar un parser que valide su forma en tiempo de ejecución.
- [OpenAPI S02](../../../docs/api/openapi.yaml) es la fuente de verdad HTTP.
  Su [guía](../../../docs/api/README.md) documenta validación, sesión, CSRF y decisiones.
- `openapi.ts` se genera desde el YAML con `npm --prefix api run api:types`
  (misma salida que la API; `api:types:check` verifica ambas en CI). No editar a mano.
- `lots-service.ts` (K011) usa esos tipos y valida `LotResponse` en runtime.
  `identity-service.ts` usa los tipos generados de identidad. Ambos servicios comparten
  `parseApiError` de `http-client.ts` para validar el sobre de errores del contrato.

- `discovery-service.ts` consulta lotes públicos y reserva con reintentos de la misma
  intención; `reservation-intent.ts` conserva clave y cantidad en la pestaña.
- `reservations-service.ts` consulta historial/detalle y cancela con CSRF; valida
  estado, ventana y coherencia del código antes de entregar datos a la vista.
- `waitlist-service.ts` consulta solicitudes y posición, ingresa con clave idempotente
  y acepta/rechaza/sale con CSRF. Usa los tipos generados y valida la coherencia
  entre estado, oferta, posición, vencimiento y reserva antes de mostrar acciones.

- `chat-service.ts` valida mensajes, secuencia y páginas con tipos generados; envía
  texto y clave idempotente con CSRF para la conversación de la reserva.
