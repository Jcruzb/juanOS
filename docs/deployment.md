# Despliegue en Ubuntu

## Requisitos

- Ubuntu 24.04 LTS, dominio y acceso root inicial.
- Puertos 22, 80 y 443.
- 2 GB RAM mínimo; 4 GB recomendados para builds.
- Node.js 22, Docker Engine + Compose, Git, rsync y sudo.
- Nginx y Certbot en el host.
- Según uso: PM2, Python/venv, PostgreSQL client, age y rclone.

## Procedimiento

1. Coloca el checkout en una release bajo `/opt/juanos/releases/<commit>`.
2. Crea `/opt/juanos/current` apuntando a esa release.
3. Ejecuta `sudo scripts/prepare-server.sh`.
4. Si hace falta, ejecuta `sudo scripts/install-docker.sh`.
5. Edita `/etc/juanos/compose.env` y `/etc/juanos/worker.env`.
6. Edita `/etc/juanos/host-policy.json`; elimina el ejemplo y declara cada app real.
7. Configura recovery y self-update en `/etc/juanos`.
8. Valida `sudo visudo -cf /etc/sudoers.d/juanos-host-helper`.
9. Ejecuta las migraciones.
10. Genera el vhost HTTP inicial y el primer certificado de JuanOS con los helpers:
    `sudo /usr/local/libexec/juanos-host-action nginx-configure --application juanos`,
    seguido de `nginx-test-reload` y `certbot-issue` con el dominio autorizado.
11. Ejecuta `sudo systemctl enable --now juanos-api.service juanos-worker.service`.
12. Ejecuta `scripts/verify.sh` y el checklist de staging.

Los contenedores API/web solo publican puertos loopback; Nginx HTTPS vive en el host. La API no
monta `docker.sock`. Las acciones privilegiadas pasan por
`/usr/local/libexec/juanos-host-action`, que solo acepta operaciones enumeradas y comprueba la
política root-owned.

## Proyectos y permisos

Las rutas host y contenedor coinciden bajo `/srv/juanos/projects`. El usuario `webterminal` usa
UID/GID 1100 para que repositorios y logs `0600` tengan el mismo propietario dentro y fuera del
contenedor.

El worker host puede modificar únicamente:

- repositorios bajo `PROJECTS_ROOT`;
- logs y recovery bajo `/var/lib/juanos`;
- rutas declaradas en la política mediante los helpers.

## Certificados

Antes de activar SSL para una app, el plan comprueba DNS A, `VPS_PUBLIC_IP`, puerto 80,
configuración Nginx y Certbot. HSTS está habilitado en producción: valida HTTPS antes de apuntar el
dominio final.

## Recovery

Configura:

- `/etc/juanos/recovery.json`;
- `/etc/juanos/recovery.pgpass` root `0600`;
- identidad age root-owned;
- remote OAuth de rclone.

Después crea y prueba un recovery desde un plan. Comprueba también por SSH:

```text
juanos-recover status
juanos-recover logs
juanos-recover snapshots
```

Consulta [`juanos-platform-implementation.md`](./juanos-platform-implementation.md) para la guía
completa y el checklist E2E.
