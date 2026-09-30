# Integración del design system

Revisión local: 2026-09-21, rama `feat/frontend-design-system`. Infraestructura
visual compartida, sin implementación K008/K009/K010/K011.
Uso cotidiano: [guía UI](../web/src/components/ui/README.md).

## Inspección y comparación

La ruta solicitada `../Design system para Rescate` no existía. El material estaba
en `../rescate-design-system`. Se inventariaron sus 146 archivos: 36 componentes
JSX con sus 36 declaraciones y prompts, documentación, 22 HTML (16 guidelines,
cuatro fichas y dos kits), ocho CSS, runtime JS, miniatura WebP y dos PDF.
Los PDF son idénticos por SHA-256 a E1 en el repositorio; no se duplicaron.
Se revisaron implementaciones, declaraciones, prompts, tokens, guías y demos antes
de adaptar. La miniatura es evidencia de demo, no un asset de producto.

| Aspecto | Rescate antes del cambio | Material externo |
| --- | --- | --- |
| Stack | React/DOM 19.2.8, Router 7.18.3, TS 6.0.2, Vite 8.3.0 | JSX React; demos con React/DOM `@18` desde unpkg, sin patch fijado |
| Build/lint | Vite/plugin React 6.1.1, ESLint 10, Hooks/Refresh y typescript-eslint; noUnusedLocals/Parameters, ESM | Sin package.json, lockfile, TSConfig ni build/lint reproducible |
| Estilos | Un global.css, valores literales y breakpoints a 48 rem | Tokens OKLCH + reset; estilos inline repetidos y hover/focus con estado React |
| Componentes | AppLayout, SiteHeader, RescateLogo; seis páginas, sin primitives | 26 componentes (core/data/feedback/dominio) y 10 pantallas/shells |
| Navegación | React Router, enlaces activos; menú móvil con Escape y cierre por enlace | Estado local de demos; avisos, usuario y establecimiento ficticios |
| Responsive | Min 320 px, contenedor 72 rem, tarjetas 46 rem | App a 1160 px con parche CSS a 900 px; panel con min-width 1280 px |
| Accesibilidad | Secciones tituladas, nav con nombre, aria-expanded, foco en enlaces/botones y feedback de salud | Intención de 44 px/contraste; faltan asociaciones, gestión de foco y teclado en varias piezas |
| Fuentes/assets | Inter declarada pero no cargada; logo textual; public vacío y favicon inexistente referenciado | Google Fonts: Bricolage Grotesque, Public Sans, IBM Plex Mono; sin archivos/licencias locales ni logo/fotos reales |
| Otras dependencias | Solo React/DOM/Router en runtime | Babel standalone y Lucide `latest` por CDN en demos; runtime con fetch, transformación y eval |

Los tokens externos definen tinta/papel, verde/ámbar/azul/rojo, cuerpo 16/1.55,
metadatos 14, microetiquetas 12; títulos 19–44 px, escala de 4 px, radios
6/10/14/20/píldora, sombras xs–lg, alturas 36/44/52 y transiciones 80/140/220/360 ms.
También tienen pulsos de tiempo y entradas/barridos no necesarios aquí. Solo light
está diseñado; la sugerencia de un selector oscuro no constituye un segundo tema.

## Selección y adaptación

- [tokens.css](../web/src/styles/tokens.css): subconjunto de escalas utilizadas,
  aliases semánticos para texto/superficie/acción/borde/feedback/disabled, tipografía,
  espaciado, radios, dimensiones, sombra xs y transición de controles.
  Tamaños de texto/espaciado en rem; valores OKLCH originales conservados.
- [UI](../web/src/components/ui/README.md): Button (cuatro variantes), Input,
  Textarea, Select nativo, FormField, Card (default/sunken), Badge y Alert (cinco
  tonos). Badge no define estados HTTP ni de negocio. Los controles de formulario
  y Badge preparan composición reutilizable para S02; no se añadió una galería.
- Card sustituye el estilo duplicable de las seis secciones existentes sin cambiar
  su semántica ni contenido. Button sustituye los botones de menú/conexión;
  Alert sustituye solo el markup de feedback. Se eliminan los estilos anteriores
  equivalentes, sin conservar dos APIs visuales. Las APIs de páginas/shell no cambian.
- SiteHeader/AppLayout/RescateLogo siguen siendo componentes de aplicación.
  Se aplica la marca textual, tipografía, borde y colores; no se añade navegación.
  `/`, `/lotes`, `/lotes/:id`, `/registro`, `/login`, `/conexion` y 404 se conservan.
- `index.html` declara español de Chile y título Rescate; se quita la referencia
  al favicon que no existía. No se inventa un logotipo.

No se importaron kits/páginas, componentes de dominio, stock, timers, Tabs, Dialog,
Tooltip, Toast, Checkbox/Switch, IconButton ni variantes urgente/inverse. No hay
consumidor actual que justifique su API/costo. Tampoco se integran franjas para
fotos/estados vacíos todavía inexistentes, sombras de modal ni panel lateral.
El modal externo no controla foco, Tabs no implementa flechas ni tabpanels,
Switch carece de asociación accesible completa y LoteCard es un article clicable
sin activación de teclado. Se posponen, no se presentan como piezas listas.

Se detectaron imports/desestructuraciones sin uso (p. ej. Tabs/Badge en Inventario),
props `any`/inyección `NS`, contadores y personas hardcodeadas, callbacks ausentes,
respuestas simuladas con timers y variantes que sobrescriben eventos. Las nuevas
piezas usan TS con props nativas, refs/eventos preservados y pseudoclases CSS.
Button no es polimórfico: los enlaces siguen siendo enlaces de React Router.

**Dependencias y assets añadidos/eliminados: ninguno.** No se cambia React, Vite,
TypeScript, ESLint, package.json ni lockfile. No se copian runtime, configuración,
.env, node_modules, builds, PDFs, miniatura, fuentes ni scripts CDN.

## Fuentes y accesibilidad

El material solo entrega una URL Google Fonts, sin archivos ni textos de licencia
para versionar. No se incorpora una fuente externa ni se afirma haber verificado
la licencia de archivos ausentes. Se eligen las pilas locales alternativas del
propio diseño (Trebuchet/Helvetica, Helvetica/Arial, monospace del sistema).
Esto conserva jerarquía, pesos e intención, pero cambia métricas y formas respecto
a Bricolage/Public Sans/IBM Plex. Autoalojarlas exige revisar origen/licencia y
pesos concretos en un trabajo posterior; no hay solicitudes remotas de fuentes.

Cambios deliberados frente al material:

- El borde de controles usa ink-500 en vez de ink-300, conservando la paleta para
  distinguirlos sobre blanco. Bordes decorativos conservan ink-200.
- Disabled usa texto/superficie explícitos en vez de reducir toda la opacidad a
  0.5. Foco azul de 2 px con offset, también en campos inválidos.
- FormField requiere label y vincula ID/ayuda/error/required mediante render prop;
  errores visibles, sin inventar validadores. Select conserva teclado/apariencia nativa.
- Botones y controles con mínimo 44 px, sin variante de 36 px; etiquetas largas
  pueden envolver. El menú devuelve el foco al disparador al cerrar con Escape.
- Movimiento reducido desactiva transiciones y desplazamiento de pulsación.

## Límites y siguientes tarjetas

El material externo mezcla diseño con reglas de dominio: espera por cantidad
completa (contradice ADR 0002), límites demo de cuatro packs, catálogo fijo de
categorías, títulos de lote y estados españoles supuestamente normativos.
No se trasladan. OpenAPI S02 exige otros campos y distingue `draft/published`;
el catálogo de categorías sigue sin acordarse. El diseño no autoriza rutas ni
operaciones nuevas y no sustituye autorización del servidor.

K009/K011 deben derivar tipos de OpenAPI, resolver integración de sesión/CSRF,
gestionar foco y errores de formulario, establecimientos reales y conflictos de
versión. Revisarán composición/responsive con contenido real, sin basarse en datos
de las demos. No se implementan auth, registro conectado, edición/publicación,
reservas, FIFO, ofertas ni fotos. No cambia código backend, OpenAPI, SQL ni Docker.

## Verificación ejecutada

Node 24.14.0, npm 11.19.0. `npm run typecheck`, `npm run lint` y `npm run build`
en `web/`: exit 0. No se añadió framework de tests ni se instaló una dependencia.
TypeScript conserva comprobación de imports/locales no usados.

Se levantó Vite con `VITE_API_BASE_URL=/api`, proxy a `127.0.0.1:33006` y puerto
4177; la API existente se ejecutó con `PORT=33006 node --import tsx src/index.ts`.
Chromium se automatizó con Playwright 1.62.1 ya disponible fuera de este repo.
Script/fixture y capturas quedaron en `/tmp/rescate-design-review`, no versionados.
El fixture se intercepta solo en ese navegador: no crea una ruta ni galería pública.

| Comprobación | Resultado observado |
| --- | --- |
| Rutas a 360 y 1366 px | Raíz, lotes, detalle, registro, login, conexión y 404 renderizan; sin scroll horizontal |
| Navegación | Redirección y vuelta del detalle preservan query string; enlaces móviles cierran menú |
| Menú con teclado | Tab, Enter, Space y Escape; foco visible y retorno al disparador |
| Salud real | GET `/api/health` a través de Vite muestra resultado correcto |
| Error/carga | 503 y respuesta demorada interceptados solo para la prueba; error visible, reintento real, disabled y aria-busy durante carga |
| Primitives aislados | Labels, IDs, ayuda/error, required, disabled, eventos focus/blur, Tab y select con flechas; Button no envía salvo type=submit |
| Responsive/movimiento | Fixture a ambos anchos sin desborde; reduced-motion desactiva transición |
| Inspección visual real | Capturas de lotes móvil/desktop, conexión móvil y primitives móvil/desktop revisadas |

Contraste calculado con colores renderizados por Canvas en sRGB y luminancia
relativa: cuerpo/papel **14:1**, secundario/blanco **7,09:1**, botón **7,71:1**,
hover **11,36:1**, error/fondo suave **8,34:1**, disabled **6,05:1**, foco/blanco
**5,73:1**, borde de input/blanco **5,02:1**. Es evidencia de esos pares,
no certificación WCAG ni prueba con lector de pantalla.

El sandbox bloqueó inicialmente Vite/Chromium; se ejecutaron con permiso local.
El fixture temporal necesitó corregir el import CommonJS de ReactDOM y declarar
UTF-8 antes de pasar. El navegador informó advertencias del websocket HMR por su
control de acceso a red local en el fixture interceptado, sin errores JavaScript
de las piezas en la ejecución final. El 503 de consola fue deliberado.
No se afirma haber probado HMR, otros navegadores, auth ni publicación.

Comandos principales (además de lectura con `rg`, `cat`, `sed` y revisión de hashes):

```sh
# web/
npm run typecheck
npm run lint
npm run build
API_PROXY_TARGET=http://127.0.0.1:33006 VITE_API_BASE_URL=/api npm run dev -- --host 127.0.0.1 --port 4177 --strictPort
# api/; solo proceso existente, sin cambios de código
PORT=33006 node --import tsx src/index.ts
# raíz; herramientas temporales fuera del repositorio
node /tmp/rescate-design-review/check.cjs
git diff --check
git status --short
git diff --stat
```

Se revisaron enlaces locales de Markdown, marcadores de conflicto, patrones de
credenciales y lista completa de archivos modificados/nuevos. No se incorporaron
secretos, `.env`, dependencias, builds ni configuración externa. Los bloques
Mermaid de arquitectura son idénticos a HEAD: no se afirma un nuevo renderizado.
No se repitieron CI remoto, Compose, migraciones ni B2, que no cambian aquí.

## Orden documental posterior

Por solicitud expresa, se recuperó la organización documental del backend sin
cambiar la implementación visual. [El índice](README.md) separa entradas por
área, referencias vigentes, ADR, evidencia y E1; [backend](backend.md) funciona
como navegación hacia documentos especializados, sin duplicar sus procedimientos.
El README raíz enlaza esa entrada. Las guías de [entorno](desarrollo-local.md) y
[migraciones](migraciones.md) distinguen operación actual de aceptación histórica.

El estado se contrastó con `development` y `origin/development` en `cb5ca3b` el
2026-09-21. OpenAPI S02 sigue siendo el contrato objetivo; únicamente `/health`
está implementado. Los PDF E1/anexos y las evidencias originales se conservaron.

En esta revisión documental pasaron `api:contract:check`, `typecheck` y `test`
de API (este último necesitó permiso de ejecución fuera del sandbox). Docker
Compose v5.4.0 está disponible y `docker compose --env-file .env.example config
--quiet` pasó; no había servicios levantados. Los procedimientos se contrastaron
con scripts npm, ayuda de CLI y configuración: no se ejecutaron migraciones,
rollback, borrado de volúmenes ni pruebas B2/CI remoto. Esto complementa, sin
sustituir, la evidencia visual anterior.
