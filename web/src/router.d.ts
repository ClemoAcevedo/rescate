import 'react-router'
import type { NavigateOptions, To } from 'react-router'

// main.tsx usa BrowserRouter: su navegación es síncrona. React Router recomienda
// precisar este retorno para no confundirlo con el modo RouterProvider asíncrono.
declare module 'react-router' {
  interface NavigateFunction {
    (to: To, options?: NavigateOptions): void
    (delta: number): void
  }
}
