# ADR 0019: presentación de fechas y cargas estables

## Estado

Aceptado.

## Contexto

Los formateadores de cada pantalla producían fechas con distinto orden, precisión
y zona horaria. Los mensajes de carga ocupaban menos espacio que las tarjetas,
galerías y formularios que reemplazaban. Las recargas también insertaban avisos
y quitaban controles, desplazando el contenido mientras se consultaba su vigencia.

## Decisión

- Centralizar la presentación en `web/src/format/date-time.ts`: `DD/MM/AAAA`,
  `HH:mm` de 00 a 23, sin segundos, y `DD/MM/AAAA · HH:mm` para un instante.
  Una ventana omite la segunda fecha solo si ambos extremos tienen el mismo día
  en la zona elegida; al cruzar medianoche muestra ambas fechas completas.
- Exigir una zona IANA explícita para cada instante. Retiros, reservas,
  operaciones e indicadores usan la zona del lote o establecimiento. Avisos y
  chat, cuyos DTO no incluyen zona, usan `America/Santiago` y lo indican en la
  pantalla. No inferir la zona del navegador ni agregar consultas para cada aviso.
- Las fechas de calendario del período no se convierten a instantes. Los inputs
  nativos conservan la presentación del navegador; su valor y la conversión de
  `datetime-local` usan la zona indicada en su ayuda. El filtro público usa Santiago.
- Reutilizar `Skeleton` y `LoadingState`. Las páginas componen formas con las
  mismas columnas, proporciones de imágenes, tipografía, espaciados y zonas de
  contenido que la vista final. Reservar espacio para texto y mantener el ancho
  del contenedor. Las formas son estáticas, decorativas y sin controles; una sola
  región de estado anuncia la carga y la región de datos declara `aria-busy`.
- Con datos visibles, conservar la estructura al actualizar. Bloquear acciones
  que dependen de vigencia; al comprobar una reserva, ocultar el código dentro
  de su espacio reservado hasta recibir el resultado. Errores, resultados vacíos
  y confirmaciones siguen teniendo texto y acciones propios.

## Alternativas descartadas

- Repetir opciones de `Intl` por pantalla: permite divergencias y deja implícitas
  las decisiones sobre precisión y zona.
- Usar siempre la zona del navegador: cambia el significado del retiro al viajar
  o abrir la aplicación desde otro dispositivo.
- Un spinner o una altura fija para cualquier vista: no representa la estructura
  adaptable ni evita el desplazamiento de las regiones importantes.
- Solo documentar la convención: no detecta una nueva llamada local ni una
  modificación CSS que desajuste el skeleton.

## Consecuencias y verificación

ESLint prohíbe `Intl.DateTimeFormat` y `toLocale*String` fuera del formateador
común y de las conversiones de `lots/lot-time.ts`. Las pruebas unitarias cubren
el formato, medianoche, cambio de año, ventanas entre días y horario de verano.
`test:web:ux` retiene respuestas HTTP y compara geometría antes/después en móvil
y escritorio; verifica también una zona de navegador distinta y la recarga de
una reserva. Ambas comprobaciones se ejecutan en CI. `AGENTS.md` exige usar las
piezas comunes y ampliar la regresión cuando cambie una vista asíncrona.

La cantidad de registros y la longitud del contenido no se conocen durante la
primera carga. Se reserva una estructura representativa; no se impone una altura
máxima que recorte direcciones, horarios o mensajes. La regresión compara las
regiones especificadas con contenido controlado; no equivale a garantizar CLS
cero para toda respuesta posible.
