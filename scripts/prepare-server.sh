#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Ejecuta este script como root en una VPS Ubuntu."
  exit 1
fi

read -r -p "Se creará el usuario webterminal y /srv/juanos. ¿Continuar? [y/N] " answer
[[ "${answer}" =~ ^[Yy]$ ]] || exit 0

if ! id webterminal >/dev/null 2>&1; then
  useradd --uid 1100 --create-home --shell /bin/bash --user-group webterminal
elif [[ "$(id -u webterminal)" != "1100" ]]; then
  echo "AVISO: webterminal usa UID $(id -u webterminal), pero los contenedores esperan UID 1100." >&2
  echo "Alinea el UID antes de desplegar para que logs 0600 y proyectos sean accesibles." >&2
  exit 1
fi

install -d -o webterminal -g webterminal -m 0750 /srv/juanos/projects
install -d -o root -g webterminal -m 0750 /opt/juanos
install -d -o webterminal -g webterminal -m 0700 /var/lib/juanos/deployments
install -d -o webterminal -g webterminal -m 0700 /var/lib/juanos/recovery
install -d -o webterminal -g webterminal -m 0700 /var/lib/juanos/backups
install -d -o root -g root -m 0750 /etc/juanos
install -d -o root -g root -m 0755 /usr/local/libexec
install -d -o root -g root -m 0755 /var/www/certbot
if command -v nginx >/dev/null 2>&1; then
  install -d -o root -g root -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled
fi

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install -o root -g root -m 0755 "${script_root}/scripts/juanos-host-action" /usr/local/libexec/juanos-host-action
install -o root -g root -m 0755 "${script_root}/scripts/juanos-recovery" /usr/local/libexec/juanos-recovery
install -o root -g root -m 0755 "${script_root}/scripts/juanos-self-update" /usr/local/libexec/juanos-self-update
install -o root -g root -m 0755 "${script_root}/scripts/juanos-recover" /usr/local/bin/juanos-recover
install -o root -g root -m 0440 "${script_root}/infra/sudoers/juanos-host-helper" /etc/sudoers.d/juanos-host-helper
visudo -cf /etc/sudoers.d/juanos-host-helper
install -o root -g root -m 0644 "${script_root}/infra/systemd/juanos-api.service" /etc/systemd/system/juanos-api.service
install -o root -g root -m 0644 "${script_root}/infra/systemd/juanos-worker.service" /etc/systemd/system/juanos-worker.service

if [[ ! -f /etc/juanos/host-policy.json ]]; then
  install -o root -g root -m 0640 "${script_root}/infra/host-policy.example.json" /etc/juanos/host-policy.json
fi
if [[ ! -f /etc/juanos/recovery.json ]]; then
  install -o root -g root -m 0640 "${script_root}/infra/recovery.example.json" /etc/juanos/recovery.json
fi
if [[ ! -f /etc/juanos/self-update.json ]]; then
  install -o root -g root -m 0640 "${script_root}/infra/self-update.example.json" /etc/juanos/self-update.json
fi
if [[ ! -f /etc/juanos/worker.env ]]; then
  install -o root -g webterminal -m 0640 "${script_root}/infra/worker.env.example" /etc/juanos/worker.env
fi
if [[ ! -f /etc/juanos/compose.env ]]; then
  install -o root -g root -m 0600 "${script_root}/infra/compose.env.example" /etc/juanos/compose.env
fi
systemctl daemon-reload

if command -v ufw >/dev/null 2>&1; then
  echo "Recomendado: permite SSH, 80/tcp y 443/tcp, verifica SSH y activa UFW manualmente."
fi

echo "Usuario, directorios y helpers preparados."
echo "Edita /etc/juanos/host-policy.json y /etc/juanos/recovery.json antes de activar operaciones."
echo "webterminal solo puede ejecutar los helpers root-owned exactos declarados en sudoers."
