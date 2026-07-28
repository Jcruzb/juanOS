#!/usr/bin/env bash
set -euo pipefail

if [[ -f .env ]]; then
  echo ".env ya existe; no se sobrescribirá."
  exit 1
fi

read -r -p "Dominio de JuanOS (ej. os.example.com): " domain
read -r -p "Correo del administrador: " admin_email
read -r -s -p "Contraseña inicial (mínimo 16 caracteres): " admin_password
echo
if [[ "${#admin_password}" -lt 16 ]]; then
  echo "La contraseña es demasiado corta."
  exit 1
fi

postgres_password="$(openssl rand -base64 36 | tr -d '\n')"
session_secret="$(openssl rand -base64 48 | tr -d '\n')"
umask 077
{
  echo "JUANOS_DOMAIN=${domain}"
  echo "POSTGRES_PASSWORD=${postgres_password}"
  echo "SESSION_SECRET=${session_secret}"
  echo "SESSION_IDLE_MINUTES=30"
  echo "PROJECTS_HOST_PATH=/srv/juanos/projects"
  echo "ADMIN_EMAIL=${admin_email}"
  echo "ADMIN_PASSWORD=${admin_password}"
} > .env
echo ".env creado con permisos privados."
