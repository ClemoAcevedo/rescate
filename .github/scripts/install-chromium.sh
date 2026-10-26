#!/usr/bin/env bash
# Instala Chromium de Playwright y sus dependencias del sistema en un runner de Actions.
# apt-get a veces se cuelga descargando de los mirrors y retiene el bloqueo de dpkg:
# timeouts de red cortos con reintentos propios de apt y, entre intentos, se termina el
# apt-get colgado para que el siguiente intento no choque con el bloqueo.
set -uo pipefail

sudo tee /etc/apt/apt.conf.d/99-ci-timeouts > /dev/null <<'APT'
Acquire::Retries "3";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
DPkg::Lock::Timeout "60";
APT

cd "$(dirname "$0")/../../api"
for attempt in 1 2 3; do
  if timeout 240 npx playwright install --with-deps chromium; then exit 0; fi
  echo "::warning::Intento $attempt de instalar Chromium falló o se colgó"
  sudo pkill -9 -x apt-get || true
  sudo pkill -9 -x dpkg || true
  sudo dpkg --configure -a || true
done
exit 1
