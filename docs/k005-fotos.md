# K005 — Almacenamiento y prototipo de fotos

Estado: **prototipo local y smoke remoto real en Backblaze B2 verificados**.
Validación remota completada el 2026-09-20; incluye carga, acceso privado y borrado
de la versión con comprobación de ausencia posterior.
Investigación documental: 2026-09-20. Las capacidades publicadas no equivalen a pruebas
ejecutadas por el equipo. Evidencia concreta en [k005-evidencia.md](k005-evidencia.md).

## Inspección y alcance

Se revisaron los archivos versionados, configuración, dependencias, plantilla de PR,
frontend, API y texto de ambos PDF de E1. La rama parte de
`133be911f1298cc7f9245b1426d336c48160b2c7`, con Express `/health`, ESM,
TypeScript estricto y build `tsc`. No contiene Docker Compose, migraciones ni
almacenamiento. El `.env` raíz existente pertenece a otra configuración: no se modifica
ni se carga. Solo se inspeccionaron sus nombres de variables, sin publicar valores.

El prototipo es una CLI independiente bajo `api/src/prototypes/photos`, compilada
por el build existente. No agrega endpoints, UI, tablas, relaciones, autenticación de
producto ni procesamiento de fotos. No depende de K002/K003/K006.

## Comparación antes de decidir

Criterios: gratuidad real para una prueba, privacidad, acceso temporal, borrado,
portabilidad, integración Node/TypeScript, operación sencilla para cinco integrantes,
persistencia y posibilidad de recuperar errores humanos.

| Alternativa | API, privacidad y borrado | Cuota gratuita publicada | Tarjeta / condiciones | Integración y dependencia |
| --- | --- | --- | --- | --- |
| **Backblaze B2** | S3, bucket privado, GET firmado; DELETE con VersionId elimina la versión | Primeros 10 GB; egress gratuito hasta 3 veces el almacenamiento medio mensual; operaciones S3 usadas aquí de clases A/B/C gratuitas | Registro anuncia sin tarjeta; confirmar límites efectivos en Caps & Alerts de la cuenta | AWS SDK v3; endpoint, región y claves en backend; dependencia particular de ACL de bucket y versionado |
| **Supabase Storage Free** | S3 o API propia; buckets privados, URLs firmadas, eliminación | 1 GB, 5 GB egress y 5 GB cached egress; archivo máximo 50 MB; dos proyectos activos; pausa tras una semana inactiva | Plan Free de $0; ausencia de tarjeta descrita en anuncio histórico, onboarding actual pendiente de confirmar | SDK JS o S3; claves S3 de proyecto omiten RLS y abarcan todos los buckets; más superficie de plataforma si solo necesitamos fotos |
| **Cloudflare R2 Standard** | S3, privado y URLs firmadas, DELETE | 10 GB-mes, 1 millón operaciones A y 10 millones B/mes; egress gratis | Documentación exige suscripción y checkout; marketing dice sin tarjeta. No asumir activación sin medio de pago hasta comprobarla; excedentes facturables | AWS SDK v3 o Workers; backend Node externo viable; compatibilidad S3 parcial |
| **Disco local** | API de archivos de Node, sin exposición HTTP; permisos Unix; unlink | Capacidad del disco, sin servicio contratado | Sin cuenta ni tarjeta; hardware y copias a cargo del equipo | Dependencia del host y volumen; no emula S3 ni sus firmas |

Fuentes de B2: [precios](https://www.backblaze.com/cloud-storage/pricing),
[registro sin tarjeta](https://www.backblaze.com/sign-up/cloud-storage),
[operaciones y clases](https://www.backblaze.com/cloud-storage/transaction-pricing),
[compatibilidad S3](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api),
[borrado con versión](https://www.backblaze.com/apidocs/s3-delete-object).
La página de transacciones conserva una nota de precio de almacenamiento distinta
de la página de precios: no se usa esa nota para cotizar. Tampoco se extrapolan
las antiguas cuotas diarias de artículos de soporte a una cuenta nueva.

Fuentes de Supabase: [plan actual](https://supabase.com/pricing),
[buckets privados](https://supabase.com/docs/guides/storage/buckets/fundamentals),
[S3 y privilegios](https://supabase.com/docs/guides/storage/s3/authentication),
[anuncio histórico sobre tarjeta](https://supabase.com/blog/2021-03-29-pricing).

Fuentes de R2: [cuotas Standard](https://developers.cloudflare.com/r2/pricing/),
[alta y checkout](https://developers.cloudflare.com/r2/get-started/),
[página comercial](https://www.cloudflare.com/products/r2/),
[acceso S3](https://developers.cloudflare.com/r2/get-started/s3/),
[compatibilidad](https://developers.cloudflare.com/r2/api/s3/api/).
La CLI remota aquí verifica B2; no se afirma compatibilidad probada con R2/Supabase
(por ejemplo, R2 no implementa GetBucketAcl y no cumple esta comprobación específica).

## Decisión y límites de viabilidad

Se recomienda **B2 privado con AWS SDK v3**, con ensayo remoto completado
satisfactoriamente en el bucket `rescate-iic3143-2026-fotos`.
Da una cuota mayor que Supabase para fotografías, anuncia registro sin tarjeta y
no requiere alojar otra plataforma. S3 permite conservar PUT/GET y firmas si se migra;
se deberán adaptar permisos y versionado. No se agrega una arquitectura genérica:
un ensayo S3 y una pequeña implementación local de put/get/remove son suficientes.

Esto es viable para un prototipo pequeño, **no demuestra capacidad gratuita para todo
E1**. Los aproximadamente 18 GB del anexo I, página 26, corresponden a un
**escenario de dimensionamiento basado en supuestos, no a consumo medido ni a un
requisito confirmado**: 10 000 lotes × tres fotos × 600 KB finales por foto.
El crecimiento de 360 MB/día también es hipotético (200 lotes diarios bajo esos supuestos).
Los 10 GB de B2 durarían unos 27,8 días en ese supuesto, sin contar
versiones, temporales ni copias. Supabase tiene aún menos margen. Es un cálculo,
no consumo medido. No cambiar silenciosamente retención ni alcance para hacerlo caber:
acordar una demo acotada o verificar recursos del curso antes del piloto completo.

## Configuración y ejecución

Requisito del ensayo: Node.js 24 (probado con 24.14.0), npm y permisos Unix para local.
Desde la raíz:

```bash
cd api
npm ci
npm run build
cp .env.example .env
chmod 600 .env
```

No sobrescribir un `api/.env` existente: añadir las variables manualmente si ya existe.
`npm run photos` carga únicamente `api/.env` al ejecutarse desde `api`; las variables
exportadas tienen prioridad. `.env` sigue ignorado; `.env.example` contiene valores
vacíos y una ruta local. Nunca poner estas claves en `web` ni en variables `VITE_*`.

| Variable | Uso |
| --- | --- |
| `PHOTO_LOCAL_DIR` | Directorio local dedicado; defecto `.k005-storage`, relativo a `api` |
| `PHOTO_S3_ENDPOINT` | Endpoint HTTPS S3 del bucket, sin nombre de bucket, credenciales ni query |
| `PHOTO_S3_REGION` | Región mostrada por B2 |
| `PHOTO_S3_BUCKET` | Nombre del bucket dedicado privado |
| `PHOTO_S3_ACCESS_KEY_ID` | `keyID` de application key restringida |
| `PHOTO_S3_SECRET_ACCESS_KEY` | `applicationKey` secreta, solo backend |

### Prueba local paso a paso

```bash
# Cada comando inicia un proceso nuevo; conservar la misma clave entre pasos.
PHOTO_KEY="k005-$(node -e 'console.log(require("node:crypto").randomUUID())').png"
npm run photos -- local upload "$PHOTO_KEY"
npm run photos -- local read "$PHOTO_KEY"
npm run photos -- local delete "$PHOTO_KEY"
npm run photos -- local absent "$PHOTO_KEY"
```

`upload` escribe el fixture PNG de cuatro colores con creación exclusiva, modo 0600
y fsync; el directorio debe ser 0700. `read` compara todos los bytes y comprueba
permisos; `delete` elimina exactamente esa clave; `absent` exige ENOENT.
Cada paso registra PASS, tamaño y SHA-256 del fixture. Si se omite `delete`, el archivo
persiste para repetir `read` después de cerrar la terminal. No hay servidor público.

Para automatizar la misma prueba y casos negativos:

```bash
npm run test:photos
```

La suite crea un directorio aleatorio en el directorio temporal del sistema y lo borra
al terminar. Comprueba persistencia entre procesos, bytes, permisos, eliminación,
sobrescritura, traversal y enlaces simbólicos. Los permisos se prueban en POSIX;
no prueban aislamiento contra el mismo usuario Unix o root. No se ejecutó lectura
con otra identidad del SO. No hay URL firmada ni prueba HTTP anónima en modo local.

### Configuración para reproducir la prueba remota

Estos pasos ya se completaron para el ensayo registrado. No es necesario recrear
la cuenta, el bucket ni la clave para repetirlo; no sobrescribir `api/.env`.

1. Crear cuenta **B2 Cloud Storage**, verificar correo y habilitar B2 (no Computer Backup).
   Mantener la modalidad gratuita sin añadir medio de pago ni habilitar funciones pagadas.
   Revisar [Caps & Alerts](https://www.backblaze.com/docs/en/cloud-storage-data-caps-and-alerts)
   y conservar límites de gasto cero; no activar Event Notifications (clase D sin cap).
   Anotar los límites efectivos de la cuenta. Si el alta exige gasto, detenerse y registrar el bloqueo.
2. Crear un bucket dedicado, por ejemplo `rescate-k005-<sufijo-unico>`, **Private**,
   sin Object Lock/retención que impida borrar, sin enlaces públicos ni CDN.
3. Crear application key para ese bucket, tipo **Read and Write**, con capacidad de
   listar versiones, leer, escribir y borrar. No usar master key en el prototipo.
   Este ensayo no lista todos los buckets; no necesita habilitar ese permiso.
   Evitar restricción de prefijo para esta primera comprobación de ACL del bucket.
   [Guía oficial de claves](https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys).
4. Guardar los cinco valores `PHOTO_S3_*` en `api/.env` **localmente**. No pegarlos
   en el chat, PR, capturas ni historial de comandos. Avisar únicamente que están configurados.

Después ejecutar desde `api`:

```bash
npm run build
npm run photos -- s3 smoke
```

La CLI usa `k005/<UUID>.png`, exclusivamente el fixture de 75 bytes, y realiza:

1. GET de ACL: solo concesiones al propietario; listar versiones y comprobar clave nueva.
2. PUT privado heredando la privacidad del bucket; conservar VersionId.
3. Destruir el cliente y crear otro; GET autenticado y comparación exacta de bytes.
4. Firmar GET por 300 segundos; HTTP 200 y comparación exacta, sin imprimir URL.
5. GET sin firma mientras el objeto existe: exigir rechazo 401/403; B2 respondió **401**
   en el ensayo real. La condición original que exigía exclusivamente 403 fue corregida.
6. GET con firma modificada: exigir rechazo 401/403; B2 respondió **403**.
7. DELETE con VersionId; GET actual y versionado deben fallar con NoSuchKey/NoSuchVersion;
   URL firmada anterior debe responder 404; listado de versiones vacío.
8. En `finally`, listar y eliminar únicamente las versiones de esa clave aleatoria y
   verificar listado vacío, incluso ante respuesta perdida de PUT.

Cada petición tiene timeout de 30 s; PUT no tiene reintentos automáticos para evitar
versiones duplicadas por respuesta perdida. Timeout, 403 después del borrado o fallo
de red **no** se toman como evidencia de inexistencia. Un fallo devuelve código 1.
Los errores SDK no se imprimen completos para no filtrar URLs o configuración;
usar el último PASS para localizar el paso. En ausencia de configuración falla antes
de conectar. Una clave insuficiente también debe fallar, no marcar privacidad aprobada.

Si el proceso es interrumpido a la fuerza o no tiene permiso de borrado, revisar en
la consola B2 **todas las versiones** de la clave mostrada al inicio y eliminarlas.
No borrar otros objetos. Conservar salida saneada, fecha, región y resultados para
completar el registro; no incluir IDs de credenciales ni URL firmada. El ensayo no
prueba expiración por espera, reinicio del servicio remoto ni disponibilidad prolongada.

## Persistencia, durabilidad y respaldo

**B2:** el proveedor anuncia diseño de durabilidad de 11 nueves, no una medición de
este proyecto. La privacidad depende del bucket (sin ACL independiente por objeto).
DELETE sin VersionId crea un marcador: por eso el ensayo borra la versión y verifica
que no quedan versiones. Las reglas de ciclo de vida pueden eliminar versiones antiguas;
no sustituyen un respaldo independiente. Fuentes:
[durabilidad](https://www.backblaze.com/cloud-storage/security),
[ciclo de vida](https://www.backblaze.com/docs/cloud-storage-lifecycle-rules),
[semántica de DELETE](https://www.backblaze.com/apidocs/s3-delete-object).

**Supabase:** los backups de PostgreSQL guardan metadatos, no los objetos de Storage.
Se requieren copias separadas; no se verificó aquí una garantía numérica de durabilidad
de Storage Free ni restauración. [Documentación de backups](https://supabase.com/docs/guides/platform/backups).

**R2:** diseño de durabilidad anual de 11 nueves con redundancia y escrituras persistidas;
esto no protege contra eliminación accidental ni equivale a una copia recuperable.
Exportar los objetos a un destino independiente si se eligiera.
[Durabilidad oficial](https://developers.cloudflare.com/r2/reference/durability/).

**Local:** sobrevive al cierre/reinicio del proceso, depende completamente del disco.
fsync del archivo no prueba recuperación ante corte eléctrico, fallo físico o pérdida
del directorio. No hay réplica, backup, cifrado propio ni SLA; no usar disco efímero
de un hosting. Requiere volumen persistente y permisos Unix en un futuro despliegue.
K006 podría montar ese directorio posteriormente; esta tarjeta no crea Compose.

E1, anexo I página 28, exige copias de imágenes finales y manifiesto de referencias,
con siete copias diarias externas. Propuesta operativa pendiente: exportar objetos
finales y manifiesto con hashes a dos equipos del equipo, cifrar copias, guardar las
claves aparte y ensayar restauración a un bucket vacío conciliando referencias.
`pg_dump` nunca respalda bytes de fotos. No se implementó ni probó este procedimiento
en K005. Bajo el escenario hipotético de 18 GB, siete copias completas serían 126 GB
por destino sin deduplicación; tampoco es consumo medido ni un requisito confirmado.
Durabilidad del proveedor no permite recuperar un borrado autorizado permanente.

## Integración futura y riesgos pendientes

K014 deberá validar bytes reales, formatos, tamaño y dimensiones, eliminar EXIF,
generar miniaturas y gestionar temporales/huérfanos. Estos scripts solo manejan un
fixture conocido; no son un endpoint de carga listo para producción. Una API futura
deberá autorizar lote/actor antes de otorgar acceso; poseer una URL firmada permite
usarla hasta su vencimiento. No registrar URLs en logs, y evitar cachés públicas.
Ninguna credencial privilegiada debe llegar al navegador.

Pendientes operativos fuera del smoke ya completado: confirmar cuotas efectivas y bloqueo de gasto;
definir presupuesto de fotos frente a E1; acceso con roles reales; expiración y
revocación de enlaces; condiciones de despliegue; copias/restauración; monitoreo de
cuotas; borrados fallidos y retención. Cambios de proveedor requieren repetir pruebas
de privacidad, firmas, consistencia y versionado. El protocolo S3 reduce, pero no
elimina, la dependencia del proveedor.
