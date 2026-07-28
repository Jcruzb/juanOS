#!/usr/bin/env bash
set -euo pipefail

docker compose config --quiet
docker compose ps
curl --fail --silent --show-error "https://${JUANOS_DOMAIN}/api/health"
echo
echo "JuanOS responde correctamente."
