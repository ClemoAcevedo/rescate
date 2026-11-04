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
el espacio del historial para mantener el formulario en su sitio.

Cuando existen datos, conservarlos al refrescar y expresar la carga en su región
y controles. No insertar un aviso encima ni quitar bloques completos durante cada
consulta. La reserva oculta el código mientras comprueba vigencia, conservando su
espacio; las acciones quedan bloqueadas hasta terminar. Los errores, resultados
vacíos y confirmaciones tienen texto y acciones propios, nunca skeletons perpetuos.

Las listas cargan una cantidad representativa de tarjetas, no el número total que
aún se desconoce. No limitar alturas ni recortar direcciones/horarios para forzar
una geometría constante con cualquier respuesta. Un cambio de estructura exige
actualizar su composición de carga y la regresión correspondiente.

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
