# Reparación de aplicaciones importadas — 13 noviembre 2026

ControlAnts no se despliega en esta reparación. Sus ramas de integración y PR siguen separados de main.

La inspección inicial de rutas se corrigió con `stat` y `findmnt`: `/srv/juanos/projects/controlants-backend` es un bind mount de `/var/www/controlants/backend/back_controlAnts2.0`; ambas rutas identifican el mismo directorio. El frontend también está montado desde `/var/www/controlants/frontend/front_ControlAnts2.0`. No se necesita reubicar el backend.

Bloqueos comprobados: configuración operativa enterrada en `strategyConfig.legacy`, pantalla sin edición, archivos auxiliares no versionados bloqueando el plan, autorización host limitada a logs/status, respaldo ausente del plan y publicación estática sin releases configuradas.

## Cambios de software

- Edición explícita y auditada de configuración, revisión antes de guardar y rechazo de ediciones concurrentes.
- Campos Django de venv, dependencias, collectstatic y respaldo conservados por el esquema.
- Plan nuevo ligado a rama/commit y configuración revisados; revalidación antes de ejecutar; sin pull sobre una rama distinta.
- Migraciones Django condicionadas a respaldo verificado.
- Preflight de systemd compara identidad de directorios, compatible con bind mounts. Bloquea un checkout realmente distinto.
- Preflight estático bloquea un destino que todavía sea directorio; no lo sobrescribe silenciosamente.

## Configuración ControlAnts preparada para revisión posterior

Backend: tipo django, estrategia systemd, ruta gestionada existente, servicio controlants-gunicorn.service, workingDirectory `.`, pythonVenv `venv`, requirements `requirements.txt`, collectstatic false (no STATIC_ROOT configurado), backupStrategy pg_dump_local, comprobación HTTP https://juancarloscruz.tech/api/csrf/ con200. Conservar main mientras se pospone ControlAnts.

Frontend: tipo frontend, static_nginx, workingDirectory `.`, buildOutputDir `dist`, comprobación HTTP https://juancarloscruz.tech/login con200. Confirmar VITE_API_BASE_URL=/api en entorno antes del próximo build.

Los archivos auxiliares `.jc-deploy.json` y package-lock.json del backend no se borran. Respaldarlos antes de excluirlos de comprobación Git o moverlos fuera del checkout; el lockfile del frontend sí forma parte del código y nunca debe excluirse.

La política root-owned no se edita desde la API. Para habilitar despliegues habrá que autorizar acciones exactas por slug: backend preflight/database-backup/systemd-restart, frontend preflight/publish-static, conservando observabilidad existente. Preparar un directorio de backups root privado y pgpass0600 en el host, sin subir secretos a Git. La conversión del frontend servido a releases debe preservar los artefactos actuales y permitir recuperación antes de publicar cambios nuevos.

## Estado de respaldo previo

ControlAnts: `/var/backups/controlants/20261113-083234-pre-release` contiene dump PostgreSQL y configuración/frontend actuales. Índice del dump comprobado, carpeta0700 y dump0600. Restauración real todavía no ensayada; los ensayos previos usaron datos demo. Crear un respaldo nuevo antes del eventual despliegue de ControlAnts, pues puede haber nuevas operaciones desde esta copia.

## Validación en VPS

Commit inicial a73b59c compilado en release aislada sin activar. En PostgreSQL17 se creó exclusivamente `juanos_config_test_20261113_repair`; los11 tests de configuración y sesión/CSRF pasaron, incluido rollback transaccional y concurrencia. El test eliminó su propio esquema temporal. La BD de producción no participó.

También se corrigió la ejecución de Python de entornos virtuales: admite enlaces seguros al intérprete del sistema y conserva la ruta del venv para cargar sus paquetes.

## Activación de JuanOS

La versión `837bf6973b6f9a90529433727c6a9d9b6c68f190` quedó activa en `/opt/juanos/current`, sin merge a main. API/web Docker saludables y worker activo; helper instalado con checksum idéntico al de la release. JuanOS `/api/health` y ControlAnts `/login` respondieron200. ControlAnts conserva su código y migraciones anteriores.

Respaldo JuanOS privado: `/var/backups/juanos/20261113-before-import-repair`, con dump adicional inmediatamente antes de activar, configuración y etiquetas Docker `before-import-repair-20261113`. Release previa conservada: `93a424bf9cc72c1adffbcd589cc4a69960911632`. Para rollback de software: detener worker, restaurar symlink a esa release, restaurar helper respaldado, reasignar imágenes preservadas a etiquetas api/web y recrear solo api/web con `--no-build`; iniciar worker y verificar salud. No restaurar la BD automáticamente: esta reparación no añade migraciones.

Pendiente: nueva sesión del usuario para revisar configuración en el panel, confirmación para ampliar acciones host específicas de ControlAnts y decisión sobre archivos auxiliares. La revisión automática rechazó añadir exclusiones locales de Git sin autorización explícita; no se aplicaron. Se prepararon `host-policy.proposed.json` y un pgpass privado dentro del respaldo, pero la política activa permanece intacta. No se ha convertido todavía el frontend servido a releases ni desplegado mejoras de ControlAnts.

## Terminal lifecycle repair (2026-11-13)

A disconnected terminal could still produce PTY output. Comparing its state against
`session.websocket.OPEN` dereferenced a null socket and crashed the API. The handler
now compares against `WebSocket.OPEN`; regression coverage emits output after the
WebSocket close event.

Migration `007_terminal_runtime.sql` adds a runtime owner to new terminal sessions.
Each API instance holds a dedicated PostgreSQL connection and a session advisory
lock for its owner. Owner registration and lock acquisition occur before commit.
At startup and every ten seconds, reconciliation ends sessions only when it can
acquire that owner's lock. It preserves live owners from other API instances.
This requires a direct/session-preserving PostgreSQL connection, not transaction
pooling. One pool connection per API instance remains reserved for ownership.

Graceful API shutdown kills its PTYs and ends its own rows before closing the DB.
Connection loss disables terminal creation and kills local PTYs. Failed PTY creation
and failed opening audit also close their new session records. HTTP diagnostics
remain available if terminal initialization fails.

Legacy rows have no runtime owner and are deliberately excluded from automatic
reconciliation. Before manually marking a legacy row ended, back it up and verify
that its owning pre-upgrade API and PTY no longer exist. Scope updates to reviewed
session IDs with `status='active'` and a verified restart cutoff; preserve history,
other projects and newer sessions. Age alone does not prove abandonment.

Validation: full `npm test` completed with **66 passed, 1 skipped, 0 failed**;
API typecheck, changed-file ESLint and `git diff --check` passed. The skipped suite
requires an explicit `JUANOS_TEST_DATABASE_URL` whose database name starts with
`juanos_config_test_`. Its new PostgreSQL test verifies that live owners and legacy
rows remain active while a disconnected owner's sessions are recovered. This new
SQL test has **not yet run on PostgreSQL 17** and must pass in an isolated database
before deploying this candidate. It creates and removes only its random test schema.

Follow-up regression also disconnects while the opening audit is pending; the API
now kills that PTY and ends its row instead of leaving an unreachable active session.
