# K005 — Evidencia local y remota

Fecha: 2026-09-20. Rama: `chore/k005-photo-storage`.
Base: `133be911f1298cc7f9245b1426d336c48160b2c7`; cambios de K005 sin commit.
Entorno: Linux, Node v24.14.0, npm 11.19.0. Pruebas sobre disco real local y
Backblaze B2 remoto, sin Docker, base de datos ni fotografías personales.
**Validación remota completada satisfactoriamente el 2026-09-20.**

## Pruebas realizadas

| Comando / comprobación | Resultado observado |
| --- | --- |
| `cd api && npm run test:photos` | 3 pruebas aprobadas, 0 fallidas; incluye build TypeScript |
| Suite: upload → nuevo proceso read → nuevo proceso delete → nuevo proceso absent | Bytes idénticos y ENOENT final; directorio de prueba vacío |
| Suite: permisos del directorio y objeto | 0700 y 0600 respectivamente |
| Suite: sobrescritura, traversal, symlink, modos públicos | Rechazados |
| Suite: S3 sin variables | Código 1 antes de conectar, sin datos sensibles impresos |
| CLI local, cuatro invocaciones npm separadas | upload, read, delete y absent: PASS |
| Ensayo inicial sin configuración: `cd api && npm run photos -- s3 smoke` | FAIL K005 (Error), esperado; registro histórico previo a configurar B2 |
| Smoke remoto real con configuración B2 | Exit 0; todas las comprobaciones aprobadas, ver detalle siguiente |
| `cd web && npm run lint` | Exit 0 |
| `cd web && npm run build` | Exit 0, Vite compiló 34 módulos |
| `cd api && npm audit --omit=dev` | 0 vulnerabilidades reportadas en dependencias de producción |
| `git diff --check` | Sin errores |
| `git check-ignore .env api/.env api/.k005-storage/example.png` | Los tres patrones siguen ignorados |

Salida final de la suite:

```text
✔ persistencia real entre procesos, permisos 0700/0600, lectura exacta y borrado
✔ rechaza sobrescrituras, traversal, enlaces simbólicos y permisos públicos
✔ S3 sin configuración falla sin red ni credenciales impresas
tests 3; pass 3; fail 0; skipped 0
```

Fixture: `api/fixtures/k005.png`, PNG RGB sintético 2×2, 75 bytes.
SHA-256: `e6d66889131220f931fddfb05730d647a0992456c63ae0a8154b4ae32ff219ef`.
La ejecución manual usó `PHOTO_LOCAL_DIR=/tmp/rescate-k005-manual` y clave ficticia
`k005-00000000-0000-4000-8000-000000000005.png`. Después de delete, absent obtuvo
ENOENT. El fixture original sigue versionable; su copia de prueba fue eliminada.

Incidencias durante verificación: un error inicial de tipos del cuerpo S3 fue corregido
usando `transformToByteArray`; el build final pasa. El sandbox rechazó los procesos
hijos con EPERM; la suite se repitió fuera del sandbox con permiso y pasó. Un comando
npm lanzado desde la raíz falló porque allí no hay package.json; se corrigió ejecutando
desde `api`. Estos fallos iniciales no se cuentan como pruebas exitosas.

## Revisión del cambio

Se revisaron código nuevo, diff de archivos existentes y lockfile: dos dependencias
directas fijadas, `@aws-sdk/client-s3` y `@aws-sdk/s3-request-presigner` 3.1136.0.
El lockfile agrega sus dependencias transitivas sin cambiar las versiones anteriores.
No existen scripts previos de test/lint en API: se usa su build y la suite específica.
Frontend sin modificaciones. No hay cambios en otras tarjetas ni importaciones del
prototipo desde `src/index.ts`.

Revisión de secretos: ejemplo con credenciales vacías, configuración solo por entorno,
sin credenciales de proveedor ni URLs firmadas en archivos versionables. No se versionan
`.env`, `dist`, `node_modules`, logs ni copias locales. Se revisó el estado completo
incluyendo archivos nuevos; el único binario agregado es el fixture conocido.
La revisión estática no constituye una certificación de seguridad.

## Validación remota real — 2026-09-20

Comando desde `api`: `npm run build` y `npm run photos -- s3 smoke`.
Build: exit 0. Smoke final: **exit 0**, finalizado a las 15:51 UTC.
Proveedor: Backblaze B2, bucket privado `rescate-iic3143-2026-fotos`.
Application key restringida proporcionada mediante `api/.env`; no se registraron
valores de credenciales, respuestas completas del proveedor ni URLs firmadas.

Objeto ficticio del ensayo final: `k005/202446c2-95a4-4a5f-843b-36d761827650.png`.
Se usó el PNG de 75 bytes y SHA-256 indicado arriba, sin datos reales.

| Comprobación remota | Resultado real |
| --- | --- |
| Privacidad del bucket/objeto | ACL solo con concesiones al propietario; ninguna pública. El objeto hereda la privacidad del bucket |
| Carga del PNG | PUT aceptado y VersionId recibido |
| Persistencia remota | Se destruyó el cliente de carga y se creó otro; GET recuperó exactamente los 75 bytes originales |
| Lectura autenticada | GET autenticado correcto, comparación completa de bytes aprobada |
| Lectura con URL firmada | HTTP 200 y bytes idénticos; URL de 300 s, no registrada |
| Acceso anónimo mientras existía el objeto | HTTP **401**, sin entregar la imagen |
| URL con firma alterada | HTTP **403**, sin entregar la imagen |
| Eliminación real | DELETE de la versión concreta aceptado; no se usó un mero marcador de borrado |
| Recuperación autenticada después de borrar | GET actual y GET por VersionId rechazados con error de objeto/versión inexistente (la prueba exige NoSuchKey o NoSuchVersion) |
| Recuperación con URL antes válida | HTTP **404** después del borrado |
| Versiones y limpieza | Listado de versiones y marcadores vacío para esa clave, confirmado también en finally |

Salida saneada del smoke final:

```text
PASS bucket privado (ACL sin concesiones públicas)
PASS upload; VersionId recibido
PASS persistencia y lectura autenticada desde cliente nuevo; bytes idénticos
PASS GET firmado 200; bytes idénticos (URL no registrada)
HTTP GET anónimo: 401
PASS GET anónimo 401 mientras el objeto existe
HTTP GET firma alterada: 403
PASS firma alterada 403
PASS delete permanente; GET actual/versionado ausentes; URL anterior 404; cero versiones
PASS limpieza del objeto de prueba
```

### Problemas encontrados y resolución

- El intento en el sandbox falló antes del primer PASS de ACL. El error se mantuvo
  saneado y no se atribuye un código de red que no fue registrado. Se repitió con
  acceso de red autorizado fuera del sandbox.
- El primer ensayo con acceso remoto pasó ACL, PUT, lectura desde cliente nuevo y
  GET firmado, pero falló al exigir exclusivamente 403 para acceso anónimo.
  Su objeto `k005/034971ea-a7d0-4be0-bbfc-55d04678b3c2.png` fue eliminado por finally
  y se confirmó que no quedaban versiones.
- Se ajustó únicamente el smoke K005 para aceptar rechazos HTTP 401/403 y registrar
  solo el código numérico. La ejecución completa posterior confirmó 401 anónimo
  y 403 con firma alterada. No se acepta un 404, timeout ni error de red como prueba
  de privacidad mientras el objeto existe.
- No quedaron objetos de estos ensayos remotos. No se modificaron ACL, configuración
  del bucket ni otros objetos. No hubo exposición de credenciales.

Después del ajuste se repitió `npm run test:photos`: build aprobado y tres pruebas
locales aprobadas (cero fallidas). `git diff --check` pasó y `api/.env` sigue ignorado.

## Límites y pendientes operativos

No hay bloqueo pendiente para el smoke remoto de K005. La prueba demuestra persistencia
remota entre clientes, permisos y borrado por API; no mide durabilidad prolongada,
reinicio del proveedor ni eliminación física de todas sus copias internas.

| Validación adicional | Estado |
| --- | --- |
| Cuotas efectivas y configuración de facturación | Cuotas públicas documentadas; no se inspeccionó el panel de facturación/Caps & Alerts |
| Acceso local con otro usuario del SO | No realizado; se verificaron modos Unix y rechazos del adaptador |
| Expiración temporal de URL y recuperación de copias | No ensayadas; procedimiento y limitaciones documentados |
| Proveedores R2 y Supabase | Comparación documental, sin conexiones remotas |

Los aproximadamente **18 GB de E1 son un escenario de dimensionamiento basado en
supuestos**, no consumo medido ni un requisito confirmado. Resultan de 10 000 lotes,
tres fotos por lote y 600 KB finales por foto. Esta prueba almacenó un fixture de
75 bytes por ejecución y lo eliminó; no valida ni exige aquella escala hipotética.

La evidencia técnica remota pendiente está completada. No se necesita otra acción
del usuario para reproducir el smoke con la configuración actual. Los límites de
cuenta y el ensayo de respaldos siguen explícitamente separados de este resultado;
no se afirma haberlos validado por ejecutar operaciones S3.

## Propuesta de PR

Título: `chore(K005): evaluar almacenamiento de fotos y preparar prototipo privado S3`

Descripción:

> K005 necesitaba una decisión de almacenamiento sin gasto obligatorio y una prueba
> reproducible. Compara B2, Supabase y R2, recomienda B2 validado mediante ensayo remoto
> y añade una CLI aislada para fixture PNG: privacidad, lectura firmada y borrado por
> versión. Incluye alternativa local y documentación de cuotas, durabilidad y copias.
>
> Validación: tres pruebas locales aprobadas, build API, lint/build web y audit de
> producción sin vulnerabilidades reportadas. Persistencia entre procesos y borrado
> local comprobados. Smoke real B2 aprobado: ACL privada, lectura autenticada y firmada,
> rechazo anónimo 401 y firma alterada 403, borrado por versión, GET posterior ausente
> y URL anterior 404; cero versiones restantes. Sin UI, tablas,
> procesamiento K014 ni dependencia de Docker/CI de K006.

No se realizó commit, push, merge ni creación de PR.
