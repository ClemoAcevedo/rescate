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

- Node.js
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