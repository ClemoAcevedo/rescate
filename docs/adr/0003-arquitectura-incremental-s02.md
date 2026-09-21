# ADR 0003: arquitectura incremental del backend para S02

Fecha: 2026-09-21. Estado: **adoptada para desarrollo incremental de S02**.
Alcance: decisión arquitectónica/documental posterior a S01, previa a K008/K010.
No acredita implementación de las capas ni de operaciones de negocio.

## Contexto

E1 propone un monolito modular con reglas compartidas entre API y trabajador
([informe, pp. 3–4](../entregas/e1/informe-e1.pdf)). El código actual tiene Express
con `/health`, navegación React/Vite, migraciones SQL, un worker inactivo y una
CLI aislada de fotos. Tener PostgreSQL/PostGIS y B2 disponibles no implica que
estén integrados con el recorrido HTTP. S02 necesita límites revisables antes de
incorporar identidad y publicaciones, y E2 debe relacionar arquitectura con código.

## Decisión

Adoptamos un **monolito modular/simple con cuatro responsabilidades**:

- **HTTP:** transporte, rutas y middleware, validación estructural, cookies y
  traducción de resultados/errores. Llama a Application; no SQL ni SDK externos.
- **Application:** casos de uso, autorización, coordinación y límites atómicos.
  Depende de Domain y ports necesarios, sin Express ni adaptadores concretos.
- **Domain:** reglas puras e invariantes, independientes de las otras tres
  responsabilidades y de detalles tecnológicos. Funciones sencillas son suficientes.
- **Infrastructure:** repositorios PostgreSQL, criptografía, sesiones y objetos;
  implementa ports sin decidir políticas de autorización ni transiciones.

Composition ensambla configuración, Pool, adaptadores, casos de uso y entradas
HTTP/worker mediante funciones y parámetros explícitos. No es una quinta capa de
negocio y no requiere un contenedor de inyección. Los ports tampoco son una capa
obligatoria: se definen junto al consumidor cuando aportan un límite útil.

Application decide qué pasos deben ser atómicos; Infrastructure ejecuta la
transacción con el mismo cliente y se ocupa de BEGIN/COMMIT/ROLLBACK. No se diseña
un Unit of Work genérico. El worker reutilizará casos de uso de Application cuando
tenga trabajos, sin duplicar reglas ni invocar la API por HTTP local.

**OpenAPI será el contrato HTTP versionado entre web y API desde S02**, al
implementar sus operaciones. Los tipos HTTP deberían derivarse de él cuando se
incorpore la infraestructura; no habrá fuentes de verdad manuales paralelas.
Domain/documentación conserva reglas de negocio y las migraciones definen
persistencia. OpenAPI no es el modelo de base de datos. K004 se conserva como
antecedente, no contrato definitivo. No se crea OpenAPI en este PR.

La [guía de arquitectura](../arquitectura/arquitectura.md) detalla estado actual,
diagramas, dependencias, ejemplos, errores, transacciones y evidencia para E2.
Se aplicará al código nuevo de manera incremental: no se mueven archivos, no se
crean carpetas vacías y no se refactoriza por uniformidad visual.

## Alternativas consideradas

| Alternativa | Evaluación |
| --- | --- |
| Mantener casos de uso y SQL en handlers Express | Poco código inicial, pero mezcla autorización, transacciones y transporte; dificulta reutilizar reglas desde el worker. |
| Cuatro responsabilidades con composición explícita | Elegida: límites suficientes para el siguiente trabajo, sin infraestructura genérica adicional. |
| Framework completo de arquitectura hexagonal/DDD, DI y Unit of Work | Añade abstracciones y mantenimiento antes de tener casos reales que las justifiquen. No se necesita para expresar estos límites. |
| Microservicios | Introduce despliegues y coordinación distribuida sin necesidad demostrada; no corresponde al monolito previsto por E1. |

## Consecuencias

- Los handlers podrán mantenerse pequeños y las reglas probarse sin Express.
  API y worker compartirán casos de uso; infraestructura seguirá siendo concreta.
- Habrá un costo acotado de contratos y mapeo entre transporte, aplicación y filas.
  No se exige duplicar cada tipo ni crear interfaces/clases sin necesidad.
- La revisión de PR comprobará dependencias y límites; todavía no hay una regla
  automática de CI que los imponga. Los diagramas deberán actualizarse con código.
- K008/K010 concretarán contratos, atomicidad y decisiones pendientes del modelo.
  No se agregan aquí endpoints, dependencias, esquema, migraciones ni trabajos.
- Se conservan ADR 0001 (gestor/SQL/pg) y ADR 0002 (ofertas parciales/FIFO y cierre
  sin prioridad residual); esta decisión no los sustituye ni cambia reglas de E1.

## Verificación al implementar

El PR de cada operación mostrará handler → caso de uso → regla/port → adaptador,
su ensamblaje y pruebas pertinentes. Revisar que HTTP no ejecute SQL, Application
no importe Express/pg/adaptadores y Domain no importe las otras responsabilidades.
Comprobar autorización en el caso de uso, transacciones en infraestructura y
errores semánticos traducidos por HTTP. No dar por implementado lo que solo existe
en el diagrama objetivo.
