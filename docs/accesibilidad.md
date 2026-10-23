# Accesibilidad y claridad de estados

La revisión cubre exploración, reserva directa, cancelación, espera y oferta.
[Reservas](reservas.md) y [cola de espera](cola-de-espera.md) explican las reglas;
[OpenAPI](api/openapi.yaml) determina las respuestas del servidor.

## Revisión técnica reproducible

Con las dependencias de `api/` y `web/` y Chromium de Playwright instalados,
iniciar Vite sin mocks de identidad y ejecutar:

```bash
npm --prefix web run dev
# En otra terminal:
WEB_URL=http://localhost:5173 npm --prefix api run test:web:accessibility
```

El recorrido usa respuestas HTTP controladas, Tab y Enter a 360 × 900 y
1366 × 900 px, con movimiento reducido. Comprueba etiquetas de filtros y cantidad,
acceso directo al contenido, foco al navegar y al recibir resultados, reserva,
conservar/cancelar, espera y aceptación de oferta parcial, ausencia de desborde y
Escape del menú móvil. Las aserciones de foco esperan la actualización de React y
el siguiente frame sin enfocar controles desde la prueba. Se incluye en `test:web:compose`. Las pruebas de
`test:web:reservations` y `test:web:waitlist` cubren además respuestas perdidas,
errores, vencimiento y recuperación. Las pruebas con API y PostgreSQL reales
se ejecutan mediante [Compose](desarrollo-local.md).

Para revisión manual, repetir los cinco recorridos siguientes en ambos anchos:

- Usar Tab y Shift+Tab: todos los controles se alcanzan en orden comprensible,
  con foco visible, sin trampas ni controles ocultos enfocables. Activar enlaces
  con Enter y botones con Enter/Espacio; cerrar el menú con Escape.
- Verificar etiquetas visibles asociadas, nombres de botones, errores y resultados
  con lector de pantalla; el contador de segundos no debe anunciarse cada segundo.
- Revisar que el texto, código, fechas y botones no queden cortados ni se superpongan;
  repetir con zoom al 200 %. El significado de un estado debe entenderse sin color.
- Comprobar que conservar devuelve el foco a cancelar y que confirmar lo lleva al
  resultado. Navegar a otra pantalla lleva el foco al contenido principal.

## Protocolo de cinco recorridos con participantes

Reclutar cinco personas que no hayan implementado la aplicación. Cada una realiza
los cinco recorridos, en una sesión individual de unos 30 minutos. Asignar 360 px
a P01/P03/P05 y 1366 px a P02/P04; alternar teclado y dispositivo apuntador,
con al menos una sesión completa solo con teclado. Registrar familiaridad con
aplicaciones y tecnología de asistencia usada, sin solicitar diagnósticos.

Usar cuentas y lotes ficticios en un entorno de prueba HTTPS con API, base y worker
activos. Preparar un lote disponible, otro agotado con cola y una oferta parcial
vigente por 4 de 10 packs. Para producirla, reservar el stock con otra cuenta,
incorporar al participante a la espera y cancelar una reserva de 4 packs desde la cuenta de apoyo.
Mantener suficiente ventana de retiro y plazo de oferta para la sesión. Preparar
otra oferta para rechazar o dejar vencer. Separar cuentas y datos por participante;
no usar reservas reales ni interceptaciones HTTP para medir comprensión.

Explicar: «Estamos evaluando la aplicación. Piensa en voz alta; puedes detenerte
cuando quieras». Pedir consentimiento para notas y, separadamente, grabación.
Usar identificadores P01–P05; no registrar contraseñas ni códigos de retiro.
El moderador lee la tarea, observa sin indicar botones y solo ayuda tras registrar
el bloqueo. Medir desde la lectura hasta que la persona declara haber terminado.

| Recorrido: consigna neutral | Preguntas al terminar | Respuesta esperada para puntuar |
| --- | --- | --- |
| 1. Encuentra un pack que puedas retirar y averigua dónde y cuándo. | ¿Cuántos packs puedes pedir? ¿Dónde y hasta cuándo retirarías? | Distingue stock libre de cantidad publicada e identifica dirección y ventana. |
| 2. Consigue un pack del lote disponible y encuentra lo necesario para retirarlo. | ¿Ya tienes una reserva? ¿Qué prueba lo confirma? ¿Qué presentarías y cuándo? | Identifica reserva confirmada, cantidad, código y ventana en el detalle vigente. |
| 3. Ya no puedes ir. Primero revisa cómo desistir sin perder la reserva; después cancélala. | ¿Qué ocurrió con los packs y con el código? ¿Podrías usarlo aún? | Conservar mantiene la reserva; cancelación confirmada libera packs e invalida el código. |
| 4. Necesitas 10 packs del lote agotado. Averigua cómo esperar y consulta tu situación. | ¿Tienes packs asegurados? ¿Qué significa tu posición? ¿Qué debe pasar para reservar? | Espera sin reserva ni packs retenidos; orden de cola y futura oferta que debe aceptar. |
| 5. Recibiste una oferta de 4 de los 10 packs. Revísala y decide aceptarla. Después revisa otra oferta que termina. | Antes de aceptar: ¿ya hay reserva y hasta cuándo puedes decidir? Después: ¿cuántos reservaste y qué pasa con los otros 6? Al rechazar/vencer: ¿sigues esperando? | Oferta con plazo, aún sin reserva; aceptación explícita crea reserva por 4 y cierra solicitud sin saldo ni prioridad; rechazo/vencimiento cierra sin reingreso automático. |

En el recorrido 5, preguntar antes de aceptar sin explicar el significado del estado.
Para la última parte, alternar rechazo (P01/P03/P05) y vencimiento (P02/P04).
Si la persona responde mal, registrar su respuesta antes de aclararla.

## Registro y evaluación

Copiar esta ficha por participante y recorrido a la descripción del PR o al registro
de la sesión enlazado desde el PR; conservar los resultados fuera de `docs/`.
Los espacios vacíos son datos por recoger, no resultados satisfactorios.

| Campo | Valor a registrar |
| --- | --- |
| Participante / recorrido / ancho / navegador / modo de entrada | |
| Tiempo / completó sin ayuda, con ayuda o no completó | |
| Comprensión de espera / oferta / reserva | 0 = incorrecta, 1 = parcial, 2 = correcta sin explicación; N/A si no se observa |
| Respuesta textual a cada pregunta | |
| Obstáculo / pantalla y paso / comportamiento observado | |
| Severidad / ayuda entregada / recuperación | Bloqueo = no puede continuar; mayor = error de estado o requiere ayuda; menor = demora recuperable |
| Hallazgo / issue / corrección / repetición del recorrido | |

Informar por recorrido éxitos sin ayuda sobre cinco, tiempos individuales y mediana,
ayudas y obstáculos por severidad. Para cada estado informar puntuaciones y número
de respuestas correctas sobre las personas que lo observaron; no convertir N/A en 0.
Una muestra de cinco sirve para detectar problemas, no para estimar a toda la población.

El cierre exige cero bloqueos abiertos en explorar, reservar y cancelar en ambos
anchos. Toda confusión entre espera, oferta y reserva se registra, se corrige y se
vuelve a evaluar con la misma consigna. Adjuntar al PR los checks ejecutados y las
fichas anonimizadas; enlazar issues para otros obstáculos. La automatización verifica
interacciones, mientras las sesiones aportan la medición de comprensión.
