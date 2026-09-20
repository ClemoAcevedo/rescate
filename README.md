# Rescate

Plataforma web para la publicación y rescate de excedentes de alimentos.

Proyecto desarrollado para IIC3143 durante el segundo semestre de 2026.

## Estructura del proyecto

El repositorio está organizado en las siguientes carpetas:

- `web` contiene la aplicación frontend desarrollada con React, TypeScript y Vite.
- `api` contiene la API desarrollada con Express y TypeScript.
- `docs` contiene documentación y entregas del proyecto.

## Requisitos

Para ejecutar el proyecto localmente se necesita:

- Node.js 24 recomendado (API: mínimo 22.13)
- npm

## Desarrollo

### Web

```bash
cd web
npm install
npm run dev
```

La aplicación se abrirá en la dirección que Vite indique en la terminal, normalmente
`http://localhost:5173`.

### Configuración de la API local

Para usar la comprobación técnica de conexión, inicia primero la API en otra terminal:

```bash
cd api
npm install
npm run dev
```

En `web`, copia el ejemplo de entorno antes de iniciar Vite:

```bash
cp .env.example .env
npm run dev
```

El valor `VITE_API_BASE_URL=/api` usa el proxy de desarrollo de Vite hacia
`http://localhost:3000`. Para otro despliegue, configura `VITE_API_BASE_URL` con la
URL base correspondiente y asegúrate de que el servidor o CORS permita las solicitudes.

La vista técnica está disponible en `http://localhost:5173/conexion`. Selecciona
**Comprobar conexión** para consultar el endpoint real `GET /health`; si falla, usa
**Reintentar comprobación** después de restablecer la API local.

La matriz de criterios y los pasos de revisión manual están en
`docs/verificacion-navegacion-web.md`.

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

```bash
cd api
npm install
npm run dev
```

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

El proyecto se encuentra en su etapa inicial de implementación.

La estructura inicial contiene la aplicación web y la API sobre las cuales se desarrollarán las funcionalidades del sistema durante las siguientes semanas.
