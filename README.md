# JuanOS

JuanOS es un centro de desarrollo privado, mobile-first, para trabajar con los proyectos de una
VPS desde Safari o cualquier navegador moderno. La prioridad es reducir la superficie de ataque:
sesiones revocables, un usuario Linux sin privilegios, rutas acotadas y operaciones de servidor
con listas cerradas.

## Estado

La plataforma incluye:

- Autenticación Argon2id, sesiones opacas con CSRF e inactividad, bloqueo temporal y auditoría.
- Dashboard móvil, terminal real xterm.js/node-pty con WebSocket autenticado y teclas táctiles.
- Explorador seguro, Monaco Editor, escritura con control de concurrencia, Git status/diff y
  operaciones Git cerradas, búsqueda y gestión de archivos/carpetas.
- Aplicaciones, importación JC-Deploy, esperado/observado y JuanOS autoprotegido.
- Planes nativos, worker persistente de host, locks, estados parciales y logs reconectables.
- PM2, systemd, static releases, Docker, Compose, Nginx, Certbot, Django y health.
- Variables `.env` con fingerprint, secrets ocultos y lifecycle build/runtime.
- Alertas, SSL, recovery cifrado age+rclone y recovery externo por SSH.
- PostgreSQL, contenedores, Nginx HTTPS y scripts de preparación de Ubuntu.
- Reconexión de la misma PTY durante cortes breves y resumen Git real en el dashboard.

Antes de considerarlo listo para Internet se debe validar en una VPS de staging: permisos Unix,
política root-owned, systemd, Docker, Nginx, Certbot, age/rclone y self-update. La aplicación no
monta `docker.sock` en la API ni ofrece ejecución arbitraria.

## Fases

- Fase 1: monorepo, autenticación, PostgreSQL, dashboard y contenedores.
- Fase 2: terminal xterm.js/node-pty, WebSocket autenticado, reconexión y teclas móviles.
- Fase 3: explorador, Monaco, búsqueda, CRUD seguro de archivos y Git status/diff.
- Fase 4: operaciones Git, despliegues serializados, logs permitidos y auditoría.
- Fase 5: endurecimiento inicial, scripts, documentación y pruebas automatizadas. La validación
  final de producción debe realizarse en una VPS de staging antes de exponer el dominio.

## Desarrollo local

### Con Docker

1. Copia `apps/api/seeds/auth.example.json` como `apps/api/seeds/auth.local.json`.
2. Cambia las credenciales del JSON; el archivo local está excluido de Git y de las imágenes.
3. Arranca con `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build`.
4. Abre `http://localhost:5173`.

La composición local publica frontend y API solo en `127.0.0.1`. El seed se monta como archivo
de solo lectura y el backend almacena únicamente su hash Argon2id en PostgreSQL.

### Sin Docker

Requisitos: Node.js 22 y PostgreSQL 17.

1. Copia `.env.example` a `.env` y cambia todos los secretos.
2. Crea la base de datos indicada en `DATABASE_URL`.
3. Ejecuta `npm install`.
4. Ejecuta `npm run db:migrate -w @juanos/api`.
5. Define `AUTH_SEED_FILE=apps/api/seeds/auth.local.json` y ejecuta
   `npm run db:seed -w @juanos/api`.
6. Ejecuta `npm run dev`.
7. Abre `http://localhost:5173`.

## Comprobaciones

`npm run lint`, `npm run typecheck`, `npm test` y `npm run build`.

La composición puede validarse sin publicar puertos con:

`docker compose up -d postgres api web`

El proxy HTTPS se inicia únicamente cuando el dominio y los certificados ya están preparados.

## VPS Ubuntu

La guía completa está en [docs/deployment.md](docs/deployment.md). En resumen: prepara el
usuario `webterminal`, crea `/srv/juanos/projects`, instala Docker, genera `.env`, obtiene un
certificado y arranca `docker compose`.

## Estructura

- `apps/web`: React + Vite.
- `apps/api`: Express, PostgreSQL y seguridad.
- `packages/shared`: esquemas Zod.
- `packages/config`: configuración validada.
- `infra`: Nginx y contenedores.
- `scripts`: instalación reversible y verificación.
- `docs`: arquitectura, seguridad, despliegue y experiencia móvil.

Consulta [arquitectura](docs/architecture.md), [seguridad](docs/security.md),
[experiencia móvil](docs/mobile-ux.md) y [problemas frecuentes](docs/troubleshooting.md).

La evolución hacia panel de operación está documentada en la
[auditoría de plataforma](docs/juanos-platform-audit.md) y en el
[estado de implementación](docs/juanos-platform-implementation.md).
# juanOS
