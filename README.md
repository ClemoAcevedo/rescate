# Rescate

Plataforma web para la publicación y rescate de excedentes de alimentos.

Proyecto desarrollado para IIC3143 durante el segundo semestre de 2026.

## Estructura del proyecto

El repositorio está organizado en las siguientes carpetas:

- `web` contiene la aplicación frontend desarrollada con React, TypeScript y Vite.
- `api` contiene la API desarrollada con Express y TypeScript.
- `docs` contiene documentación y entregas del proyecto.

## Requisitos

Para levantar todos los servicios, usa Docker con Compose v2 siguiendo la
[guía de entorno local y CI (K006)](docs/desarrollo-local.md). Incluye clonación,
variables, verificaciones, detención y limpieza. No depende de K002.

Para ejecutar web/API directamente en el host se necesita:

- Node.js 24.14.0 recomendado (API: mínimo 22.13)
- npm

## Desarrollo

### Web

La [guía del frontend](web/README.md) reúne estructura, rutas y checks.
El [design system compartido](web/src/components/ui/README.md) aporta tokens y
primitives reutilizables; esta base visual no implementa autenticación ni
publicación de lotes.

```bash
cd web
npm ci
npm run dev
```

La aplicación se abrirá en la dirección que Vite indique en la terminal, normalmente
`http://localhost:5173`.

### Configuración de la API local

Para usar la comprobación técnica de conexión, inicia primero la API en otra terminal:

```bash
cd api
npm ci
# Configurar api/.env según la sección API de abajo.
npm run dev
```

En `web`, copia el ejemplo de entorno antes de iniciar Vite:

```bash
cp .env.example .env
npm run dev
```

El valor `VITE_API_BASE_URL=/api` usa el proxy de desarrollo de Vite hacia
`http://localhost:3000`. Para otro despliegue, configura `VITE_API_BASE_URL` con la
URL base correspondiente. Para autenticación usa HTTPS del mismo origen; no habilites CORS abierto con credenciales.

La vista técnica está disponible en `http://localhost:5173/conexion`. Selecciona
**Comprobar conexión** para consultar el endpoint real `GET /health`; si falla, usa
**Reintentar comprobación** después de restablecer la API local.

Las comprobaciones técnicas del entorno y del proxy están en la
[guía de desarrollo local](docs/desarrollo-local.md).

Para crear una compilación de producción:

```bash
cd web
npm run build
```

Para comprobar las reglas de estilo y calidad:

```bash
cd web
npm run lint
```

### Rutas del frontend

La aplicación usa rutas gestionadas en el navegador. En producción, el servidor web debe
responder con `index.html` para las rutas internas desconocidas (fallback de SPA); de otro
modo, una recarga directa, por ejemplo en `/lotes/demo`, puede responder 404.

### API

La [guía del backend](docs/backend.md) permite encontrar arquitectura, contrato,
persistencia, operación y evidencia histórica.

```bash
cd api
npm ci
npm run dev
```

La API necesita `DATABASE_URL`, `RESCATE_ALLOWED_ORIGINS`, `CSRF_SIGNING_KEY` y
un esquema ya migrado. Copia `api/.env.example` a `api/.env`, configura una clave
propia y aplica las migraciones antes de iniciarla. K008 exige `users` vacío al
aplicar su migración: si hay filas, aborta sin modificarlas. Configuración HTTPS,
pruebas y explicación de seguridad en [K008](docs/k008-identidad.md).

La API incluye un endpoint básico de salud:

```text
GET /health
```

Una ejecución correcta responde:

```json
{
  "status": "ok"
}
```

### Publicación de lotes (K010)

La API expone el borrador y la publicación de lotes según OpenAPI, con versión
optimista, inmutabilidad tras publicar y autorización por establecimiento.

```text
POST   /establishments/:establishmentId/lots  crear borrador
GET    /lots/:lotId                          consultar un lote
PATCH  /lots/:lotId                          editar parcialmente
POST   /lots/:lotId/publish                  publicar
```

Todas requieren una sesión K008 válida y membership del establecimiento. Los
comandos exigen además Origin permitido y CSRF firmado. La cabecera de actor de
desarrollo ya no autentica. K008 expone `POST /auth/register`, `POST /auth/login`,
`GET /auth/session` y `POST /auth/logout`; registro no asigna permisos ni inicia sesión.

El contrato, las decisiones y las pruebas están en
[docs/k010-publicacion-lotes.md](docs/k010-publicacion-lotes.md).

## Documentación

### Migraciones PostgreSQL (K002)

Usamos `node-pg-migrate` con SQL en `api/migrations/` y mantenemos `pg`.
Con una base PostgreSQL disponible, desde `api/`: ejecuta `npm ci`, copia
`.env.example` a `.env`, configura `DATABASE_URL` y ejecuta `npm run db:migrate`.
`npm run db:create -- nombre` crea una migración y `npm run db:rollback` revierte
la última. K002 incluye solamente una tabla técnica de prueba.

Consulta la [guía y prueba reproducible](docs/migraciones.md) y el
[ADR de elección](docs/adr/0001-gestor-de-migraciones.md).
La prueba completa de K002 pasó contra PostgreSQL 16.15: aplicación, historial,
segunda ejecución sin cambios, rollback y reaplicación.

Las entregas y documentos asociados al proyecto se encuentran en `docs`.

Actualmente se incluye la documentación correspondiente a E1:

```text
docs/
└── entregas/
    └── e1/
        ├── informe-e1.pdf
        └── anexos-e1.pdf
```

Estos documentos contienen el contexto, requerimientos y decisiones definidas durante la primera etapa del proyecto.

El [índice de documentación](docs/README.md) incluye las decisiones posteriores.
La [arquitectura actual y objetivo incremental S02](docs/arquitectura/arquitectura.md)
separa lo implementado de las cuatro responsabilidades que guiarán el backend.
El [ADR 0003](docs/adr/0003-arquitectura-incremental-s02.md) registra esa decisión
y [AGENTS.md](AGENTS.md) contiene las reglas para desarrollar incrementalmente.
La regla vigente de [ofertas parciales y resolución de la solicitud](docs/adr/0002-ofertas-parciales.md)
complementa E1 sin modificar los PDF históricos ni implementar todavía ese flujo.

## Flujo de trabajo

Las ramas permanentes del proyecto son:

- `main`
- `development`

`main` mantiene las versiones estables del proyecto.

`development` corresponde a la rama de integración del trabajo en desarrollo.

Las nuevas ramas se crean desde `development`.

Se utiliza la siguiente convención:

```text
feature/nombre
fix/nombre
chore/nombre
docs/nombre
test/nombre
```

Por ejemplo:

```text
feature/login
fix/session-expiration
chore/docker-compose
docs/domain-model
test/reservation-concurrency
```

Los cambios se integran mediante Pull Request.

Cada Pull Request debe:

- indicar la tarjeta asociada
- explicar brevemente los cambios realizados
- indicar cómo comprobar los cambios
- ser revisado por al menos otro integrante antes de integrarse

No se realizan cambios directamente sobre `main` o `development`.

## Tarjetas

Las tareas del proyecto se identifican mediante un ID que debe mantenerse entre el tablero Kanban, los Pull Requests y el registro de horas.

Por ejemplo:

```text
K001
K002
K003
```

## Estado actual

En el árbol de trabajo actual, la web tiene navegación, pantallas de demostración y
comprobación de salud. La API expone `/health`, identidad K008 y lotes K010; el worker está inactivo.
K002/K003 aportan migraciones y modelo; K005 es un prototipo aislado de fotos.
OpenAPI S02 rige las ocho operaciones implementadas de identidad y lotes.

La base de `development` incluye el design system compartido. K010 implementa
publicación en backend con autenticación K008; K009 integra registro/sesión en la web y
[K011](docs/k011-formulario-lotes.md) el formulario de borrador y publicación del operador. El
[índice documental](docs/README.md) separa referencias vigentes de evidencia histórica.
