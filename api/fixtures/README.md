# Fixtures

## K012

`demo-data.mjs` define tres cuentas, dos establecimientos y cuatro lotes ficticios con IDs estables.
Cada establecimiento tiene un borrador y un lote publicado; el visitante no tiene lotes propios.
Incluye una contraseña pública de prueba y declaraciones de lote con fechas
relativas. La semilla usa el adaptador scrypt de la API; no guarda contraseñas
en texto en PostgreSQL. [Datos de demostración](../../docs/lotes.md#datos-de-demostración).

## K005

`k005.png` es un PNG RGB de 2 × 2 píxeles (rojo, verde, azul y blanco),
creado programáticamente para esta prueba. No contiene fotografías, datos personales
ni metadatos EXIF. Se versiona únicamente este fixture; las copias de prueba se borran.

La comparación exacta de bytes demuestra integridad del almacenamiento. No constituye
validación de imágenes de usuarios ni implementa el procesamiento previsto en K014.
