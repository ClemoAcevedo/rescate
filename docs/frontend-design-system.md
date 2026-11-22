# Design system del frontend

La interfaz comparte tokens semánticos, primitives React/TypeScript y CSS plano.
El material visual de Claude Design se adapta al stack local; no se copian sus
runtimes, demos, dependencias CDN ni contratos ficticios. El contrato HTTP sigue
siendo [OpenAPI](api/openapi.yaml).

## Piezas compartidas

- [Tokens](../web/src/styles/tokens.css): colores OKLCH, aliases de superficie,
  texto, borde y acción; tipografía local, escala de 4 px, radios y movimiento.
- [Guía UI](../web/src/components/ui/README.md): controles, formularios,
  tarjetas, badges, avisos y skeletons. Sus props conservan la semántica nativa.
- [Estilos UI](../web/src/styles/ui.css): apariencia de primitives, importada por
  [global.css](../web/src/app/global.css), que define reset y layout adaptable.
- `Icon`, `LotCard`, `LotGallery`, `OperatorPageHeader` y las composiciones de
  carga son componentes de aplicación. No introducen DTO ni reglas de negocio
  en `ui/`.

Se usa tema claro y fuentes locales: Trebuchet/Helvetica para títulos,
Helvetica/Arial para interfaz y monospace del sistema para códigos. No se cargan
fuentes externas. Reutilizar los tokens antes de agregar valores arbitrarios.

## Fechas y horas

El [ADR 0019](adr/0019-fechas-y-cargas-estables.md) establece la convención.
Toda presentación usa [date-time.ts](../web/src/format/date-time.ts):

| Dato | Función | Ejemplo |
| --- | --- | --- |
| Fecha de calendario `YYYY-MM-DD` | `formatDate` | `04/11/2026` |
| Instante RFC 3339 con zona explícita | `formatInstant` | `04/11/2026 · 09:05` |
| Ventana del mismo día local | `formatWindow` | `04/11/2026 · 09:05 – 11:00` |
| Ventana entre días | `formatWindow` | `04/11/2026 · 23:00 – 05/11/2026 · 01:00` |

Reloj de 24 horas, sin segundos. La zona se elige por significado: lote para
retiros/reservas/operaciones, establecimiento para el panel; avisos y chat usan
`America/Santiago` y lo explican porque sus DTO no incluyen una zona.
Nunca usar la zona del navegador como valor implícito.

Los inputs nativos `date` y `datetime-local` conservan la presentación que ofrece
el navegador. Su ayuda indica la zona; las conversiones de edición siguen en
[lot-time.ts](../web/src/lots/lot-time.ts). El filtro de retiro convierte desde y
hacia Santiago, incluso si el navegador está en otra zona.

## Carga y estabilidad visual

`Skeleton` dibuja una forma decorativa estática con los tokens de superficie;
`LoadingState` agrupa las formas y anuncia la carga una vez. La región que recibe
los datos debe marcar `aria-busy`. Las formas no contienen controles ni enlaces,
no reciben foco y no necesitan animación para comunicar progreso.

Componer el skeleton con las mismas clases de layout, columnas, tipografía,
proporciones de fotos y separación de la vista final. Mantener el ancho del
contenedor desde la carga. Las tarjetas públicas reservan espacio para título,
descripción y metadatos; galerías conservan su relación de aspecto; el chat reserva
el espacio del historial para mantener el formulario en su sitio. Los títulos
de lote de las cargas de detalle y listados usan texto decorativo representativo
que se ajusta al ancho, para reservar también las líneas de títulos extensos
en móvil. Mientras se comprueba la sesión, validar retiros, reportar un problema
y reservar packs muestran la estructura del formulario sin exponer controles
antes de que estén disponibles.

Cuando existen datos, conservarlos al refrescar y expresar la carga en su región
y controles. No insertar un aviso encima ni quitar bloques completos durante cada
consulta. La reserva oculta el código mientras comprueba vigencia, conservando su
espacio; las acciones quedan bloqueadas hasta terminar. Los errores, resultados
vacíos y confirmaciones tienen texto y acciones propios, nunca skeletons perpetuos.

Las listas cargan una cantidad representativa de tarjetas, no el número total que
aún se desconoce. No limitar alturas ni recortar direcciones/horarios para forzar
una geometría constante con cualquier respuesta. Un cambio de estructura exige
actualizar su composición de carga y la regresión correspondiente.

## Criterios de interacción

- Poner primero el dato y la acción que necesita la persona, con vocabulario del
  producto y sin UUID ni explicaciones del backend. Base: [PR #201](https://github.com/ClemoAcevedo/rescate/pull/201).
- Conservar lo escrito y los datos disponibles ante un error o una consulta lenta;
  distinguir fallo, vacío y resultado incierto. Una precarga tardía no sobrescribe
  campos que la persona ya modificó. Base: [PR #94](https://github.com/ClemoAcevedo/rescate/pull/94)
  y [PR #199](https://github.com/ClemoAcevedo/rescate/pull/199).
- Comprobar la carga con la distribución final y la zona horaria del dato, también
  cuando el navegador está en otra zona. Base: [PR #192](https://github.com/ClemoAcevedo/rescate/pull/192).
- Mantener etiquetas, foco visible y navegación completa con teclado. La
  confirmación destructiva enfoca primero su pregunta y devuelve el foco al
  conservar. Base: [PR #145](https://github.com/ClemoAcevedo/rescate/pull/145)
  y [PR #211](https://github.com/ClemoAcevedo/rescate/pull/211).
- Revisar menú, controles y textos largos desde 320 px, con datos reales y con
  vacío, error y reintento. Las pruebas comprueban resultados y geometría; las
  capturas complementan esa evidencia.
- El botón «Menú» deja espacio para el contador de avisos en la cabecera
  compacta. Su nombre accesible indica la acción y la cantidad de avisos sin leer.

## Verificar cambios

Desde la raíz:

```sh
npm --prefix web run typecheck
npm --prefix web run lint
npm --prefix web test
npm --prefix web run build
npm --prefix api run test:web:ux
```

Las pruebas de fechas cubren ceros, medianoche, cambio de año, horario de verano
y ventanas de varios días. Lint impide formateadores de presentación por pantalla.
La regresión UX inicia Vite si no hay `WEB_URL`, usa Chromium ya instalado en
`api/` e intercepta HTTP: no requiere API ni PostgreSQL ni crea cuentas.

`test:web:ux` retiene respuestas y compara posiciones/dimensiones de las regiones
especificadas a 360 y 1366 px, con navegador en Tokio. También comprueba el filtro
horario, el formato de avisos/chat, la recarga de la reserva y el movimiento
reducido. CI lo incluye en `test:web:compose`. La comparación usa contenido
controlado; no mide CLS de todas las respuestas posibles.

Revisar además con teclado, contenido largo, vacío, error/reintento y movimiento
reducido. `test:web:responsive` recorre 320–1920 px; `test:web:accessibility`
comprueba foco y etiquetas. Procedimiento en [accesibilidad](accesibilidad.md).
