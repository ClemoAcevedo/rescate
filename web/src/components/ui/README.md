# UI compartida de Rescate

Sistema claro adaptado del material de Claude Design; React/TypeScript y CSS plano,
sin dependencias nuevas. [Decisiones y verificación](../../../../docs/frontend-design-system.md).

## Qué reutilizar

- [tokens.css](../../styles/tokens.css): paleta base OKLCH, aliases semánticos,
  tipografía, escala de 4 px, radios, dimensiones, sombra y movimiento.
- [ui.css](../../styles/ui.css): apariencia de los primitives. Se carga una vez
  desde [global.css](../../app/global.css), que conserva reset y layout de aplicación.
- `Button`: primary/secondary/ghost/danger, `loading`, `disabled`, `block` y props
  nativas. Por defecto `type="button"`; el envío debe declarar `type="submit"`.
- `Input`, `Textarea`, `Select` en `FormControls.tsx`: controles nativos con props,
  eventos y refs de React 19. El select recibe `option`/`optgroup` como hijos.
- `FormField`: label obligatorio, ayuda/error e ID único; enlaza el control mediante
  las props del render prop. El error sustituye la ayuda; no valida datos.
- `Card`: contenedor div/section/article, tono default/sunken. No es clicable;
  para navegar, colocar un enlace real dentro.
- `Badge`: metadato neutral/success/warning/info/danger, siempre con texto.
- `Alert`: los mismos tonos; elegir `role="status"` para resultados asíncronos o
  `role="alert"` para errores urgentes. Un aviso estático no necesita live region.

```tsx
import { Button } from './Button'
import { FormField } from './FormField'
import { Input, Select } from './FormControls'

<FormField label="Correo" hint="Usa tu correo habitual." required>
  {(control) => <Input {...control} name="email" type="email" autoComplete="email" />}
</FormField>
<FormField label="Establecimiento">
  {(control) => (
    <Select {...control} name="establishmentId">
      <option value="">Selecciona un establecimiento</option>
    </Select>
  )}
</FormField>
<Button disabled>Acción no disponible</Button>
```

Son ejemplos de composición, no formularios de K009/K011. La página aportará las
opciones, estado, errores y callbacks. `loading` bloquea el botón y marca `aria-busy`;
el consumidor debe aportar texto visible de progreso y resultado. No hay timers,
peticiones, validaciones de negocio ni catálogo de estados dentro de UI.

## Mantención

Reutilizar primero estas piezas y los tokens semánticos (`--text-danger`,
`--surface-card`, `--sp-4`), antes de agregar variantes. Crear un primitive solo
para una responsabilidad visual compartida que no tenga equivalente. Login,
editor de lotes y dashboard pertenecen a `pages/` o componentes de aplicación;
servicios y DTO quedan fuera de `ui/`. [OpenAPI](../../../../docs/api/openapi.yaml)
determina los contratos HTTP; los tipos K004 son históricos.

No sustituir labels por placeholders. Propagar las props de `FormField` al único
control; si se añaden otras descripciones, combinar sus IDs con `aria-describedby`.
Mantener el foco visible, controles de al menos 44 px y texto que explique errores
y disabled. No usar solo color para comunicar estados. Tras validar un formulario,
la página debe gestionar foco/resumen de errores; `FormField` no anuncia cada tecla.
Probar teclado, 360/1366 px y movimiento reducido al cambiar interacciones.

Solo tema claro. Fuentes locales compatibles con el diseño: Trebuchet/Helvetica
para títulos, Helvetica/Arial para interfaz y monospace de sistema; no se cargan
Bricolage Grotesque, Public Sans ni IBM Plex Mono desde Google. El único breakpoint
de aplicación sigue siendo 48 rem en `global.css`; no hay un token CSS ficticio
para media queries. No introducir una galería o framework de demos sin necesidad.
