# Panel del establecimiento (RF10/RF12)

El operador ve en `/operador/panel` («Mi establecimiento») el estado vigente de sus lotes,
las reservas y solicitudes de espera, el historial y los resultados de los lotes que
cerraron en un período (anexos A p. 3, informe E1 p. 5 y maqueta M05 del anexo G). El
contrato HTTP está en [OpenAPI](api/openapi.yaml) (etiqueta `Panel`).

## Reglas

- **Por establecimiento.** Solo un operador con membership actual consulta el panel. Otro
  establecimiento responde 403 sin datos y un lote ajeno en el filtro responde 404 igual
  que uno inexistente. Ningún dato mezcla establecimientos.
- **Sin titulares ni códigos.** Compromisos e historial no muestran quién reservó ni el
  código de retiro, igual que la [revisión de códigos](reservas.md#vista-del-operador).
- **Estado vigente.** Un lote cierra cuando se registra su cierre o, sin registro, cuando
  termina su ventana. Una reserva o una oferta vence a su plazo aunque el
  [trabajador](vencimientos.md) no lo haya registrado, y una oferta vencida sin registrar
  ya cuenta como libre. El panel no depende del retraso del worker.
- **Ahora.** Lista los lotes publicados con la ventana abierta y su inventario
  Q = F + O + R + E + X ([ADR 0006](adr/0006-inventario-del-lote.md)), las reservas por
  retirar, las ofertas por aceptar y las personas en espera, que no poseen packs. Los
  totales son la suma de esas filas.
- **Período.** Cuenta solo los lotes cerrados dentro del período, en días locales de la
  zona del establecimiento, con ambas fechas incluidas. Sin fechas son los últimos 7 días
  con hoy incluido; el máximo es 366 días. Los lotes abiertos y los borradores quedan
  fuera y se informan junto a los indicadores.
- **Indicadores.** Packs retirados sobre packs publicados, y reservas vencidas sobre
  reservas que llegaron a confirmarse. Cada uno lleva numerador y denominador; sin
  denominador no hay tasa. Solo la entrega acreditada por el operador cuenta como
  retirada: no es consumo ni se convierte en kilos o ahorro. Las ofertas no aceptadas y
  la espera no son reservas.
- **Cuadre.** En un lote cerrado, publicados = retirados + no asignables, y las reservas
  canceladas, vencidas y retiradas suman las confirmadas. Los retirados coinciden con
  `deliveries`.
- **Historial.** Publicación y cierre del lote, reservas directas, ofertas emitidas,
  aceptadas, rechazadas o vencidas, ingresos y salidas de la espera, cancelaciones,
  vencimientos y retiros. Una reserva nacida de una oferta aparece una vez, como oferta
  aceptada. Los hechos simultáneos muestran primero el cierre del lote.

Las incidencias del lote y sus avisos (pendientes, generados y leídos) se agregan al panel
con RF11 (#46, #48).

## Contrato HTTP

| Método | Ruta | Resultado |
| --- | --- | --- |
| GET | `/establishments/:establishmentId/panel?from&to` | 200, estado vigente y resultados del período |
| GET | `/establishments/:establishmentId/commitments?lotId&state&page` | 200, reservas y solicitudes de espera, creación descendente, páginas de 20; `state` es `active` o `ended` |
| GET | `/establishments/:establishmentId/activity?lotId&page` | 200, hechos más recientes primero, páginas de 20 |

Son lecturas: sin CSRF. Un parámetro desconocido, repetido o con formato inválido, una
fecha inexistente o un período invertido o mayor a un año responden 422.

## Web

«Mi establecimiento» aparece en la navegación de quien opera un establecimiento. Muestra
cuatro cifras de hoy, una tarjeta por lote abierto con su barra de inventario (la leyenda
lleva los mismos valores como texto), los resultados del período con un formulario de
fechas, los compromisos filtrables por lote y estado, y el historial. El establecimiento,
el período, el lote y el estado viven en la URL. «Actualizar» vuelve a consultar todo.

## Pruebas

| Comando | Qué comprueba |
| --- | --- |
| `npm --prefix api test` | Período por defecto, una sola fecha, invertido y de 366 días; día local de Santiago; tasas sin denominador; autorización y totales como suma de filas; estado vigente de los compromisos; transporte HTTP contra OpenAPI y 422 por parámetro. |
| `npm --prefix api run db:test:panel:compose` | PostgreSQL real con dos establecimientos: cierre registrado y sin registrar, oferta aceptada, cola, borrador, período en días de Santiago, cuadre con `commitments` y `deliveries`, compromisos vigentes y terminados sin solaparse, historial ordenado y paginado, accesos cruzados y respuestas sin códigos ni titulares. |
| `npm --prefix api run test:web:panel` | Chromium con API real: cifras, inventario, indicadores y exclusiones, filtros por estado y por lote, validación del período, acceso por establecimiento, 360 px sin desplazamiento horizontal y sin 429. Corre dentro de `test:web:compose`. |
