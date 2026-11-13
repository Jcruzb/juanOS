# Reparación de aplicaciones importadas — 13 noviembre 2026

La reparación de JuanOS se completó antes del despliegue de ControlAnts. Posteriormente el usuario autorizó ese despliegue, registrado al final. Sus ramas de integración y PR siguen separados de main.

La inspección inicial de rutas se corrigió con `stat` y `findmnt`: `/srv/juanos/projects/controlants-backend` es un bind mount de `/var/www/controlants/backend/back_controlAnts2.0`; ambas rutas identifican el mismo directorio. El frontend también está montado desde `/var/www/controlants/frontend/front_ControlAnts2.0`. No se necesita reubicar el backend.

Bloqueos comprobados en el diagnóstico inicial (resueltos durante esta reparación, como se detalla abajo): configuración operativa enterrada en `strategyConfig.legacy`, pantalla sin edición, archivos auxiliares no versionados bloqueando el plan, autorización host limitada a logs/status, respaldo ausente del plan y publicación estática sin releases configuradas.

## Cambios de software

- Edición explícita y auditada de configuración, revisión antes de guardar y rechazo de ediciones concurrentes.
- Campos Django de venv, dependencias, collectstatic y respaldo conservados por el esquema.
- Plan nuevo ligado a rama/commit y configuración revisados; revalidación antes de ejecutar; sin pull sobre una rama distinta.
- Migraciones Django condicionadas a respaldo verificado.
- Preflight de systemd compara identidad de directorios, compatible con bind mounts. Bloquea un checkout realmente distinto.
- Preflight estático bloquea un destino que todavía sea directorio; no lo sobrescribe silenciosamente.

## Configuración ControlAnts guardada y preparación autorizada

Backend: tipo django, estrategia systemd, ruta gestionada existente, servicio controlants-gunicorn.service, workingDirectory `.`, pythonVenv `venv`, requirements `requirements.txt`, collectstatic false (no STATIC_ROOT configurado), backupStrategy pg_dump_local, comprobación HTTP https://juancarloscruz.tech/api/csrf/ con200. Conservar main mientras se pospone ControlAnts.

Frontend: tipo frontend, static_nginx, workingDirectory `.`, buildOutputDir `dist`, comprobación HTTP https://juancarloscruz.tech/login con200. Verificar VITE_API_BASE_URL=/api en entorno antes del próximo build de ControlAnts.

La configuración de ambos proyectos ya se guardó explícitamente desde JuanOS. Se generaron planes de backend y frontend, pero **no se ejecutaron**. Ambos preflight del helper pasan.

Los archivos auxiliares `.jc-deploy.json` y `package-lock.json` del backend se respaldaron y recibieron exclusiones locales exactas autorizadas; los checkouts gestionados quedaron limpios. No se borraron esos archivos. El lockfile versionado del frontend se conserva y no se excluye.

La autorización específica del host y la credencial privada para respaldo PostgreSQL ya se instalaron con autorización del usuario. La política sigue siendo root-owned y no se puede modificar desde la API. El respaldo real de ControlAnts producido durante la preparación ocupa 120235 bytes, tiene modo0600 y su índice se verificó. No se publican credenciales en este documento.

El frontend servido se convirtió a una release mediante intercambio atómico, conservando el directorio original para recuperación. Se comprobaron los15 archivos: el contenido servido es idéntico al anterior. Esta conversión no publica las mejoras pendientes de ControlAnts.

## Estado de respaldo previo

ControlAnts: `/var/backups/controlants/20261113-083234-pre-release` contiene dump PostgreSQL y configuración/frontend actuales. Índice del dump comprobado, carpeta0700 y dump0600. Restauración real todavía no ensayada; los ensayos previos usaron datos demo. Crear un respaldo nuevo antes del eventual despliegue de ControlAnts, pues puede haber nuevas operaciones desde esta copia.

## Validación en VPS

Commit inicial a73b59c compilado en release aislada sin activar. En PostgreSQL17 se creó exclusivamente `juanos_config_test_20261113_repair`; los11 tests de configuración y sesión/CSRF pasaron, incluido rollback transaccional y concurrencia. El test eliminó su propio esquema temporal. La BD de producción no participó.

También se corrigió la ejecución de Python de entornos virtuales: admite enlaces seguros al intérprete del sistema y conserva la ruta del venv para cargar sus paquetes.

## Activación de JuanOS

La versión `837bf6973b6f9a90529433727c6a9d9b6c68f190` quedó activa en `/opt/juanos/current`, sin merge a main. API/web Docker saludables y worker activo; helper instalado con checksum idéntico al de la release. JuanOS `/api/health` y ControlAnts `/login` respondieron200. ControlAnts conserva su código y migraciones anteriores.

Respaldo JuanOS privado: `/var/backups/juanos/20261113-before-import-repair`, con dump adicional inmediatamente antes de activar, configuración y etiquetas Docker `before-import-repair-20261113`. Release previa conservada: `93a424bf9cc72c1adffbcd589cc4a69960911632`. Para rollback de software: detener worker, restaurar symlink a esa release, restaurar helper respaldado, reasignar imágenes preservadas a etiquetas api/web y recrear solo api/web con `--no-build`; iniciar worker y verificar salud. No restaurar la BD automáticamente. Esa primera activación no añadía migraciones; la corrección posterior de terminales añade la migración007 descrita abajo.

La restricción inicial sobre ampliar permisos y excluir archivos quedó superada por la autorización explícita posterior del usuario; se aplicaron únicamente los cambios concretos descritos arriba. No quedan pendientes esas aprobaciones. En esa fase las mejoras de ControlAnts seguían pospuestas; después fueron autorizadas y desplegadas, como se registra al final.

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
rows remain active while a disconnected owner's sessions are recovered. The candidate `bbe5bad26e2c5f8c37d74c1e4eec55db01e98d55` subsequently passed
**12/12 tests with no skips on PostgreSQL 17**, in the isolated test database.
The test creates and removes only its random test schema. The full host build and
API Docker image build also passed.

Follow-up regression also disconnects while the opening audit is pending; the API
now kills that PTY and ends its row instead of leaving an unreachable active session.

## Instalación de la corrección de terminales

Versión instalada: `bbe5bad26e2c5f8c37d74c1e4eec55db01e98d55`. **Validación final E2E completada**. La API arrancó el 2026-11-13 a las 14:08:14.468776453Z; desde el panel se abrió una terminal backend a las 14:08:37, se ejecutó una salida diferida con `sleep 5` y `printf` y se navegó a configuración. Tras esperar más de 20 segundos, la sesión del propietario 1 quedó finalizada automáticamente a las 14:09:03. La API mantuvo su hora de arranque y contador de reinicios 0, saludable.

JuanOS `/api/health` respondió correctamente, el worker y `controlants-gunicorn` siguen activos y ControlAnts `/login` respondió HTTP200. Se conservaron las configuraciones revisadas de frontend y backend. En esa verificación de JuanOS aún no se habían desplegado las mejoras de ControlAnts. No se fusionó ninguna rama con main.

Antes de instalar se prepararon `database-before-terminal-fix.dump` y la imagen de recuperación `juanos-api:before-terminal-fix-20261113`. La migración007 es aditiva: incorpora propietarios de terminales y una referencia opcional en las sesiones existentes. Para revertir el software, recuperar la release y la imagen API previas conservadas, manteniendo ese esquema adicional. **No eliminar columnas/tablas ni restaurar automáticamente la BD**: el software previo tolera las adiciones y restaurar el dump podría borrar operaciones posteriores. Usar el respaldo de BD solo mediante un procedimiento separado que contemple esos datos.

Se respaldaron y marcaron como finalizadas únicamente siete sesiones legacy de ControlAnts anteriores al reinicio de API observado, tras comprobar que no quedaban sus PTY. Se conservaron el historial, las sesiones de otros proyectos y las filas posteriores. Las filas legacy restantes no se cierran automáticamente.

## Preparación final del worker y despliegue posterior de ControlAnts

Tras la autorización explícita del usuario, JuanOS completó los despliegues de backend `4122aa1` y frontend `677c5cd`, sin fusionar main. El ensayo Django en producción aprobó 86 comprobaciones con dos familias sintéticas y reversión completa de sus registros, sin llamadas a IA externa. Se corrigió únicamente una secuencia histórica atrasada de `auth_user`, avanzándola de 2 a 3 bajo bloqueo de tabla, sin modificar datos existentes.

Para que `webterminal` reconozca los repositorios gestionados se registraron entradas `safe.directory` exactas para `/srv/juanos/projects/controlants-backend` y `/srv/juanos/projects/controlants-frontend`. No se autorizó un comodín ni se desactivaron las comprobaciones de propiedad de Git.

El worker utiliza `NPM_CONFIG_CACHE=/var/lib/juanos/npm-cache` en `worker.env`, con una caché escribible específica del servicio. El entorno previo se conserva en `/var/backups/juanos/20261113-before-import-repair/worker-before-npm-cache.env`. No se relajó el aislamiento del servicio ni se ejecutó npm como root para eludir el problema.

Respaldo ControlAnts previo al despliegue: `/var/backups/controlants/juanos/b6a34377-79a7-4ee8-b722-5d2f1c02016e.dump`,120313 bytes, índice verificado. Cualquier recuperación debe conservar las migraciones aditivas y datos posteriores; no restaurar la BD de forma automática. La comprobación final en navegador pasó: ingresos, financiación, lectura y borrador Nilo, Dashboard y Gastos cargan correctamente sin errores; se conservaron los datos existentes y no se confirmaron movimientos en el navegador. Release estática: `/var/www/controlants/frontend-releases/677c5cd4e944c8fdeba27c058367a1adb1079054`. Micrófono real no verificado.
