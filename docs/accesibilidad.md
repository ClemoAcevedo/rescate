# Accesibilidad y claridad de estados

K033 revisa teclado, foco, etiquetas y pantallas a **360 y 1366 px**, con ausencia
de bloqueos en explorar, reservar y cancelar. Incluye la preparación de un protocolo
de cinco recorridos con personas ajenas a la implementación para medir comprensión
de espera, oferta y reserva y registrar obstáculos.

[Reservas](reservas.md) y [cola de espera](cola-de-espera.md) explican las reglas;
[OpenAPI](api/openapi.yaml) determina las respuestas del servidor.

## Verificación exclusiva de K033

Con las dependencias de `api/` y `web/` y Chromium de Playwright instalados,
iniciar Vite sin mocks de identidad y ejecutar:

```bash
# Terminal 1, desde la raíz:
npm --prefix web run dev
# Terminal 2, desde la raíz:
WEB_URL=http://localhost:5173 npm --prefix api run test:web:k033
```

Usar en `WEB_URL` el esquema y puerto que indique Vite; por ejemplo,
`https://localhost:5174` si se inició con HTTPS en ese puerto.

El comando ejecuta únicamente `test:web:accessibility`, con HTTP controlado;
requiere Vite, sin API, PostgreSQL ni worker. Recorre exploración, reserva y
cancelación con teclado a 360 × 900 y 1366 × 900 px. Comprueba etiquetas de filtros
y cantidad, foco visible y destino del foco al navegar y recibir resultados,
conservar/cancelar, ausencia de desborde y Escape del menú móvil. También presenta
espera, oferta y reserva para comprobar sus mensajes y la navegación entre estados.
Las aserciones esperan la actualización de React sin enfocar controles desde el test.

Para la revisión manual, recorrer explorar, reservar y cancelar en ambos anchos:

- Usar Tab y Shift+Tab: controles alcanzables en orden comprensible, foco visible
  y sin trampas. Activar enlaces con Enter y botones con Enter/Espacio; cerrar el
  menú con Escape.
- Verificar etiquetas visibles asociadas a filtros y cantidad, nombres de botones
  y texto de resultados y estados.
- Comprobar que texto, código, fechas y acciones no queden cortados ni superpuestos.
- Abrir cancelación, conservar y volver a cancelar: el foco llega a la confirmación,
  vuelve a cancelar al conservar y llega al resultado tras confirmar.

La evidencia del PR distingue el comando ejecutado, la revisión manual realizada y
el protocolo preparado. K033 pide preparar el protocolo; no fija un número de
participantes ni exige ejecutar las sesiones para cerrar la tarjeta.

## Distribución y regresiones independientes

La cabecera usa menú hasta 1280 px. Las tarjetas ajustan columnas al espacio y el
panel del lote se apila bajo la galería hasta 1024 px; en escritorio va a su lado.
`test:web:responsive` conserva la regresión ampliada de 320 a 1920 px.
`test:web:compose` conserva la suite general, incluidos backend, fotos, reservas,
cola y worker. Ambas pruebas son independientes de la verificación exclusiva de K033.

## Protocolo de cinco recorridos

Invitar a personas ajenas a la implementación. Preparar sesiones a 360 o 1366 px
para observar ambos anchos. El moderador lee la consigna sin indicar botones,
observa y registra obstáculos antes de ayudar.

Usar cuentas y lotes ficticios en una instancia HTTPS de prueba con sus servicios
activos ([preparación local](demo-e3.md#recorridos-moderados)). Preparar un lote
disponible y otro agotado con cola. La espera no admite más packs de los que tiene el
lote, así que la oferta parcial por 4 de 10 usa un lote de 10 reservado por dos
cuentas de apoyo, con 4 y 6 packs: el participante entra a la espera por 10 y se
cancela la reserva de 4. Conservar suficiente ventana de retiro y generar la oferta
justo antes de revisarla. Separar cuentas y datos por participante.

Explicar: «Estamos evaluando la aplicación. Piensa en voz alta; puedes detenerte
cuando quieras». Pedir consentimiento para notas y, separadamente, para grabación
si se utiliza. Identificar participantes como P01, P02, etc., sin registrar
contraseñas ni códigos de retiro.

| Recorrido: consigna neutral | Preguntas de comprensión | Respuesta esperada |
| --- | --- | --- |
| 1. Encuentra un pack que puedas retirar y averigua dónde y cuándo. | ¿Cuántos packs puedes pedir? ¿Dónde y hasta cuándo retirarías? | Identifica disponibilidad, dirección y ventana. |
| 2. Consigue un pack del lote disponible y encuentra lo necesario para retirarlo. | ¿Ya tienes una reserva? ¿Qué lo confirma? ¿Qué presentarías y cuándo? | Identifica reserva confirmada, cantidad, código y ventana en el detalle vigente. |
| 3. Ya no puedes ir. Revisa cómo desistir sin perder la reserva y después cancélala. | ¿Qué ocurrió al conservar? ¿Qué cambió al cancelar? ¿El código sigue sirviendo? | Conservar mantiene la reserva; la cancelación confirmada invalida el código y libera los packs. |
| 4. Necesitas 10 packs del lote agotado. Averigua cómo esperar y consulta tu situación. | ¿Tienes packs asegurados? ¿Qué significa tu posición? ¿Qué falta para reservar? | La espera no crea reserva ni retiene packs; requiere recibir y aceptar una oferta. |
| 5. Recibiste una oferta de 4 de los 10 packs. Revísala, acéptala y consulta el resultado. | Antes: ¿ya tienes reserva y hasta cuándo puedes decidir? Después: ¿cuántos reservaste y qué ocurre con los otros 6? | La oferta tiene plazo y requiere aceptación; aceptar crea reserva por 4 y cierra la solicitud sin saldo ni prioridad por los restantes. |

Preguntar antes de explicar el significado del estado. Registrar la respuesta
original antes de cualquier aclaración.

## Registro de comprensión y obstáculos

Copiar esta ficha por participante y recorrido al registro de la sesión enlazado
desde el PR. Los campos vacíos corresponden a datos por recoger.

| Campo | Valor a registrar |
| --- | --- |
| Participante / recorrido / ancho / navegador / modo de entrada | |
| Resultado | Completó sin ayuda / con ayuda / no completó |
| Respuestas textuales | |
| Comprensión de espera / oferta / reserva | 0 = incorrecta, 1 = parcial, 2 = correcta sin explicación; N/A si no se observa |
| Obstáculo / pantalla y paso / comportamiento observado | |
| Severidad / ayuda entregada / recuperación | Bloqueo = no puede continuar; mayor = error de estado o requiere ayuda; menor = demora recuperable |

Al ejecutar sesiones, informar resultados sobre el número real de participantes,
con respuestas y obstáculos por recorrido. Mantener N/A separado de las respuestas
incorrectas. Guardar las fichas anonimizadas fuera de `docs/` y enlazarlas desde el PR.

El cierre de K033 reúne la revisión de teclado, foco, etiquetas y pantallas a ambos
anchos, cero bloqueos en explorar, reservar y cancelar y este protocolo preparado
con cinco recorridos, medición de comprensión y registro de obstáculos.
