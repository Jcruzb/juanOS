#!/bin/sh
set -eu

npm run db:migrate -w @juanos/api
if [ -n "${AUTH_SEED_FILE:-}" ] || { [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; }; then
  npm run db:seed -w @juanos/api
fi
exec node apps/api/src/server.js
