# ADR 0015: deploy de worker y web en paralelo

Estado: adoptada en el cierre de S06. Cambia el orden del
[workflow de producción](../../.github/workflows/deploy.yml) descrito en
[despliegue](../despliegue.md).

## Contexto

El deploy subía API, worker y web uno tras otro, y luego verificaba el sitio público.
La API va primero porque Railway ejecuta las migraciones como pre-deploy. La web
consulta solo la API (`/api` por el proxy de Vercel) y no se comunica con el worker. El
worker lee la misma base migrada. Esperar al worker antes de publicar la web agregaba
algo más de un minuto sin proteger ninguna dependencia.

## Decisión

Tras el `SUCCESS` de la API, worker y web se despliegan en paralelo. La verificación
pública con Chromium espera a ambos, y el release `deploy-<SHA>` sigue exigiendo los
cuatro trabajos. La concurrencia `production` sin cancelación no cambia.

## Alternativas descartadas

- **Mantener la serie API → worker → web.** Si falla el worker, la web no se publica.
  Pero la API nueva ya está activa, así que la web anterior convive igual con una API
  nueva; detenerla no evita versiones mezcladas.
- **Desplegar los tres en paralelo.** La API debe migrar antes de que worker y web
  usen el esquema nuevo.

## Consecuencias

Si falla el worker, la web nueva ya puede estar publicada junto a la API nueva, que es
la combinación que se verifica. El worker anterior sigue registrando vencimientos y
avisos sobre el esquema migrado hasta que se reintente el deploy, y no se crea el
release. Un fallo de la web no detiene el worker. El tiempo total baja de ~4,5 a ~3,3
minutos con las duraciones actuales.
