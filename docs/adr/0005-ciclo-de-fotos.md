# ADR 0005: ciclo de fotos de lotes

Estado: adoptada para K014. Resuelve D-05 de [#102](https://github.com/ClemoAcevedo/rescate/issues/102).
E1 (anexos I pp. 24–25) fija fotos opcionales, hasta tres por lote, validación de
bytes reales, versiones sin EXIF y visibilidad solo de imágenes listas. Este ADR
concreta cómo se cargan, publican y leen. El funcionamiento está en [fotos](../fotos.md).

## Decisiones

**Publicar con una foto que no está lista (D-05): se rechaza con 422.** La publicación
exige que toda foto activa esté lista; el operador espera la validación o quita la
foto. Las fotos quedan fijas al publicar, y omitirla en silencio cambiaría lo que el
operador revisó. Se descartó publicar omitiendo las fotos no listas por ese motivo.

**Carga a través de la API, no con URL firmada directa al bucket.** E1 describe una
autorización breve para cargar a un objeto temporal privado. La API autoriza y
reserva la carga por 5 minutos, lee el cuerpo en una ruta binaria separada del límite
JSON y lo escribe en el almacenamiento. Se descartó la URL firmada de PUT: exige CORS
en el bucket, una ruta de confirmación adicional y un mecanismo distinto para el
almacenamiento local de desarrollo y CI. Con 5 MiB por archivo y dos cargas por
operador, el tránsito por la API es acotado.

**Lectura a través de la API, no con URL firmada de GET.** La API decide en cada
lectura si la foto es visible (publicada, o borrador para su operador) y entrega el
WebP generado. Se descartó entregar URLs firmadas: quien obtiene una URL la puede
usar hasta que venza, queda en historial y registros, y no sirve igual para el
almacenamiento local. El costo es tráfico por la API, acotado a 500 KiB por imagen y
100 KiB por miniatura, con caché privada de una hora para lotes publicados.

**Validación en el worker con estados en PostgreSQL.** La API solo comprueba firma y
tamaño; decodificar y transformar ocurre en el worker, una foto por vez. Un reclamo
con vencimiento reemplaza una cola externa: sobrevive a reinicios sin Redis ni broker
(ADR 0003). Las claves de objeto se derivan del ID de la foto, de modo que repetir una
validación sobrescribe y no duplica.

**sharp/libvips para decodificar y codificar.** Decodifica JPEG, PNG y WebP, limita
los píxeles antes de decodificar, aplica la orientación y no copia metadatos a la
salida. Trae binarios precompilados para la imagen Debian de la API. Se descartaron
librerías en JavaScript puro por memoria y velocidad con archivos de 20 MP, y
ImageMagick por requerir binarios del sistema.

## Consecuencias

- La web completa las rutas de imagen con su base `/api`; el contrato no expone
  claves de objeto ni URLs del proveedor.
- API y worker comparten configuración de almacenamiento. Sin ella, cargar responde
  503 y el worker queda inactivo; el resto del sistema funciona.

## Verificación

`db:test:photos:compose` prueba D-05, autorización, límites, reinicio, limpieza y el
recorrido HTTP con PostgreSQL real; `npm test` prueba la transformación con sharp y
el transporte contra OpenAPI.
