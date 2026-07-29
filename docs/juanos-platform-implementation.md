# Implementación de JuanOS Platform

Fecha de corte: 28 de julio de 2026.

Este documento describe el incremento aplicado después de la auditoría
[`juanos-platform-audit.md`](./juanos-platform-audit.md). JuanOS no ejecuta JC-Deploy ni depende
de su CLI. Los archivos históricos se usan exclusivamente como entrada de importación.

## Arquitectura final

```text
Safari / navegador móvil
        │ HTTPS + WebSocket autenticado
        ▼
Nginx ──► Web React
        └► API Express
              ├── auth / CSRF / audit
              ├── applications / import
              ├── environments
              ├── plans / deployments
              ├── alerts / SSL / recovery
              ├── deployment log tail
              ├── operational log broker
              └── terminal PTY no-root
                         │
                         ▼
                    PostgreSQL
                         ▲
                         │ cola + locks + sesiones de log
Deployment Worker (host, webterminal)
        ├── Git / npm / yarn / pnpm / Python / PM2
        ├── health / observación / alertas
        └── sudo -n a helpers root-owned enumerados
                  ├── systemd
                  ├── Docker / Compose
                  ├── Nginx / Certbot
                  ├── publicación por releases
                  ├── backup
                  ├── recovery age + rclone
                  └── self-update JuanOS
```

La API y web permanecen en contenedores con puertos publicados solo en loopback; Nginx/Certbot y
el worker se ejecutan en el host. Esto evita montar `docker.sock` dentro de la API y permite que el
worker utilice las herramientas reales de la VPS.
PostgreSQL, publicado solo en loopback, funciona como cola sencilla y fuente de verdad.

En desarrollo puede utilizarse `EMBEDDED_WORKER=1`. Producción utiliza
`EMBEDDED_WORKER=0` y `juanos-worker.service`.

## Modelo de datos

Las migraciones `001` a `004` cubren:

- `projects` como entidad Application, incluyendo tipo, estado, `is_juanos`, estados de proceso,
  HTTP y funcional, esperado/observado y decisiones temporales sobre divergencias.
- `repositories`, con commit actual, desplegado y remoto separados.
- `deployment_strategies` y configuración JSONB.
- `application_services` para frontend, API, worker y demás componentes.
- `environments`, `environment_files` y `environment_variables`; la base guarda metadata, no los
  valores secretos.
- `deployments`, `deployment_steps` y `deployment_locks`.
- `deployment_artifacts`, `application_releases` y `database_backups`.
- `health_checks` y `health_observations`.
- `application_domains` y `certificates`.
- `alerts`, `operational_events` y `system_observations`.
- `port_reservations`.
- `recovery_snapshots`.
- `operational_log_sessions`.
- `import_records` y `audit_logs`.

Los índices parciales impiden dos operaciones destructivas activas sobre la misma aplicación y
dos releases activas a la vez. Un índice único impide registrar dos aplicaciones como JuanOS.

## Funcionalidades implementadas

### Aplicaciones, discovery e importación

- Catálogo PostgreSQL mobile-first.
- JuanOS marcado como `ESTA APLICACIÓN`.
- Detección de Git, package.json, Django, Dockerfile, Compose, servicios Compose, PM2 ecosystem y
  metadata JC-Deploy.
- Lectura opcional de `apps.json` histórico.
- Evidencia y clasificación `confirmed`, `probable`, `ambiguous` y `not_detected`.
- Confirmación obligatoria cuando se detectan estrategias contradictorias.
- Los JSON históricos no se modifican ni vuelven a consultarse como fuente operativa tras importar.
- Wizard repo → clasificación → estrategia → configuración → dominio/salud → plan de registro.

### Configurado frente a observado

- El mantenimiento inspecciona Git y proceso principal.
- Actualiza rama, HEAD, commit remoto, cambios locales, estado PM2/systemd/Docker/Compose y fecha de
  inspección.
- El detalle muestra esperado y observado por separado.
- Acciones explícitas: aceptar el observado como esperado, ignorar durante una hora o abrir un
  plan `repair` para restaurar.
- Nunca se sobrescribe el sistema por detectar una divergencia.

### Motor de despliegue

- Plan JSON estructurado, validado, versionado y firmado con SHA-256.
- El usuario ve pasos, advertencias y privilegios antes de confirmar.
- No existe un endpoint `execute command`.
- Acciones nativas para:
  - Git clone/status/fetch/compare/pull;
  - npm, yarn y pnpm con lockfile obligatorio;
  - builds Node;
  - venv/pip, Django migrate y collectstatic;
  - PM2;
  - systemd;
  - frontend estático mediante releases y symlink atómico;
  - Dockerfile;
  - Docker Compose pull/build/up/restart;
  - Nginx;
  - DNS, puerto 80 y Certbot;
  - backup;
  - health;
  - recovery, rollback estático y self-update.
- `npm ci` se usa cuando corresponde; no se generan lockfiles en producción.
- Los pasos y timestamps sobreviven al cierre del navegador.
- Un worker interrumpido antes de modificar reencola; después de modificar marca `partial`.
- El log completo queda en archivo `0600`; PostgreSQL conserva resumen y referencia.
- La reconexión de logs funciona incluso con API y worker en procesos distintos.
- Los commits de repositorio, artefacto desplegado y remoto no se confunden.

### Frontera privilegiada

`scripts/juanos-host-action` es un helper root-owned con acciones y parámetros cerrados. Lee
`/etc/juanos/host-policy.json`, también root-owned, y comprueba que cada servicio, contenedor,
Compose file, dominio, ruta Nginx, release y backup pertenecen a la aplicación.

Para aplicaciones systemd y Docker Compose importadas, la pestaña Logs permite solicitar una
autorización de observabilidad. La API guarda una solicitud en PostgreSQL; el worker host valida
mediante el helper que la ruta está bajo `PROJECTS_ROOT` y que el servicio o Compose existen. Solo
entonces el helper actualiza atómicamente la política con acciones de estado y logs. La API no
recibe permisos para escribir la política ni acceso a `docker.sock`.

No acepta shell, comandos, rutas arbitrarias ni argumentos Docker genéricos. No expone `down -v`,
`volume rm` ni `system prune`.

La implementación no solicita la contraseña sudo en React. Se eligió una alternativa más segura
para una VPS de un único administrador: `sudo -n` permite únicamente tres helpers exactos mediante
`/etc/sudoers.d/juanos-host-helper`. El plan sigue mostrando qué pasos requieren privilegios.
No hay contraseña sudo en HTTP, WebSocket, PostgreSQL, logs, archivos, argv o estado React.

### Logs

- Deployment logs con WebSocket y tail desde archivo persistido.
- Broker PostgreSQL para logs operativos, de modo que la API en contenedor no toca systemd,
  Docker ni Nginx.
- Fuentes: PM2, systemd, Docker Compose y Nginx access/error.
- Servicios y paths salen de la configuración registrada/política; el frontend no puede elegir una
  ruta.
- Las fuentes privilegiadas no abren una sesión hasta que el administrador confirma el servicio
  detectado y el worker termina la autorización limitada.
- 100, 500 o 1000 líneas; follow; pausa/reanudar; búsqueda; copia; fuente y servicio.
- Sesiones con propietario, expiración, cancelación y auditoría.

### Variables de entorno

- Detección de `.env`, variantes por entorno y templates.
- Parser que preserva orden, comentarios, líneas vacías, EOL, comillas y valores con `=`.
- Sintaxis desconocida y claves duplicadas pasan a revisión.
- Valores ocultos; reveal individual explícito y auditado.
- Fingerprint SHA-256 y transición a `changed` si el archivo fue modificado fuera de JuanOS.
- Edición con control de concurrencia por fingerprint.
- Clasificación build/runtime/both y aviso implícito por lifecycle.
- PostgreSQL almacena claves y metadata; los valores siguen en archivos reales.

### Salud, puertos, SSL y alertas

- Estados separados para proceso, HTTP y funcional.
- Health HTTP configurable con status, timeout, reintentos y match.
- Sin health configurado el plan advierte `No verificado`.
- Preflight de puertos y registro de colisiones.
- DNS A comparado con `VPS_PUBLIC_IP`, comprobación de puerto 80 y `nginx -t` antes de Certbot.
- Inventario de certificados, días restantes y Certbot dry-run.
- Centro de alertas para app offline, health, SSL, renovación, `.env`, update, disco,
  deployment parcial y recovery.
- Worker periódico para disco, Git, procesos, certificados y materialización/resolución de alertas.

### Recovery y self-update

`scripts/juanos-recovery`:

1. crea y valida un dump PostgreSQL custom;
2. copia solo configuraciones declaradas;
3. genera manifest con tamaños y SHA-256;
4. crea tar temporal;
5. cifra con `age`;
6. sube con `rclone`;
7. comprueba existencia;
8. descarga una copia y compara checksum;
9. elimina temporales;
10. devuelve metadata que el worker persiste.

`recovery_test` descarga, comprueba checksum, descifra en temporal, valida manifest y archivos,
ejecuta `pg_restore --list` y elimina todo sin restaurar.

La abstracción `RcloneRecoveryProvider` soporta cualquier remote de rclone, incluido OneDrive y
Google Drive, sin almacenar OAuth en PostgreSQL.

`scripts/juanos-recover` funciona por SSH con la interfaz caída: status, logs, restart, version,
snapshots y rollback de release.

`scripts/juanos-self-update` prepara una release, ejecuta `npm ci --include=dev` para disponer
de las herramientas de compilación incluso con `NODE_ENV=production`, ejecuta build y migraciones, valida,
activa el symlink y programa reinicios separados de API y worker. El plan JuanOS obliga a crear un
recovery antes.

### UX móvil

- Navegación: Inicio, Proyectos, Actividad, Terminal y Ajustes.
- Dashboard con VPS, alertas, aplicaciones y acciones rápidas.
- Detalle: Resumen, Deploys, Logs, Variables, Servicios, Configuración, Terminal y Archivos.
- Wizard de alta en cinco pantallas.
- Terminal contextual a la ruta de aplicación.
- Logs y terminal ocupan el espacio útil; no dependen de hover.
- QA real a 390×844: dashboard, detalle y wizard sin overflow horizontal.

## Funcionalidad limitada o pendiente

La base funcional está terminada, pero estas capacidades requieren deliberadamente una validación
o ampliación antes de llamarlas universales:

- La detección de aplicaciones aún no enumera procesos PM2, units systemd, vhosts Nginx y
  contenedores no asociados a un directorio candidato. Sí contrasta esos sistemas una vez
  registrada la aplicación.
- El parser Compose identifica servicios pero no representa todavía todos los puertos,
  dependencias, volúmenes y healthchecks del YAML.
- El rollback automático implementado es solo para frontend estático por releases. Docker,
  systemd, configuración y base de datos conservan modelo/historial, pero no prometen rollback.
- `functional_health_status` está modelado; solo cambia cuando se incorpore una comprobación
  funcional específica. Process y HTTP sí están operativos.
- La restauración completa de un bundle remoto es un runbook manual. La verificación automática no
  restaura producción intencionalmente.
- OneDrive/Google Drive requieren que el administrador complete OAuth de rclone fuera de JuanOS.
- No se probaron operaciones root reales en esta máquina macOS: systemd, Nginx, Certbot, Docker
  host, age, rclone, pg_dump remoto y self-update deben validarse en una VPS staging.
- Las migraciones fueron validadas estáticamente y por tests, no ejecutadas contra PostgreSQL 17
  local porque no había daemon Docker/PostgreSQL disponible.
- Monaco sigue creando un chunk superior a 500 kB; es una mejora de rendimiento, no un fallo.

## Riesgos conocidos

- La política del host es la barrera principal. Un cambio incorrecto de
  `/etc/juanos/host-policy.json` puede autorizar el servicio equivocado.
- La redacción de secretos es defensa en profundidad y no puede prometer cobertura heurística
  perfecta.
- Health URLs pertenecen al administrador único. Un futuro modelo multiusuario necesitaría una
  política SSRF más restrictiva.
- El worker usa sudo acotado; `NoNewPrivileges` no puede activarse en su unit porque impediría los
  helpers. La protección se apoya en sudoers exacto, ownership y parámetros cerrados.
- Un rollback de código nunca equivale a rollback de datos.

## Instalación en Ubuntu

Requisitos:

- Ubuntu con systemd;
- Node.js 22;
- Docker Engine + Compose;
- PostgreSQL 17 del Compose, publicado solo en `127.0.0.1:5433`;
- Git, rsync, sudo;
- opcionales según uso: PM2, Python/venv, Nginx, Certbot, age, rclone, pg_dump.

Como root, desde el checkout:

```text
scripts/prepare-server.sh
```

El script:

- crea `webterminal` con UID 1100;
- prepara `/srv/juanos`, `/opt/juanos`, `/var/lib/juanos` y `/etc/juanos`;
- instala helpers y `juanos-recover`;
- instala y valida sudoers;
- instala las units systemd;
- copia configuraciones de ejemplo sin sobrescribir las existentes.

Después:

1. edita `/etc/juanos/compose.env`;
2. edita `/etc/juanos/worker.env`;
3. edita `/etc/juanos/host-policy.json` con servicios/rutas reales;
4. configura `/etc/juanos/recovery.json`;
5. crea `/etc/juanos/recovery.pgpass` como root `0600`;
6. genera una identidad age y configura su recipient;
7. configura rclone mediante OAuth fuera de JuanOS;
8. edita `/etc/juanos/self-update.json`;
9. instala una release en `/opt/juanos/releases/<commit>` y apunta `/opt/juanos/current`;
10. ejecuta migraciones;
11. habilita `juanos-api.service` y `juanos-worker.service`;
12. valida HTTPS, login y helpers en staging.

Nunca copies los ejemplos con secretos sin reemplazarlos.

## Recovery externo

```text
juanos-recover status
juanos-recover logs
juanos-recover version
juanos-recover snapshots
sudo juanos-recover restart
sudo juanos-recover rollback <release>
```

Para probar un snapshot sin restaurar, usa la UI:

```text
Actividad → Despliegues → Probar recovery → Generar plan → Confirmar
```

Si la UI no arranca, `juanos-recover` permite volver a una release funcional. La restauración de
PostgreSQL desde un bundle verificado debe hacerse con la aplicación detenida y siguiendo un
runbook revisado; no se automatiza una restauración destructiva desde el navegador.

## Checklist E2E de staging

- [ ] Migraciones 001–004 aplican sobre una copia de producción.
- [ ] Login/logout, CSRF, bloqueo e inactividad.
- [ ] Cookies Secure/SameSite y origen exacto en ambos WebSocket.
- [ ] Terminal global y contextual como `webterminal`.
- [ ] Import histórico y ambigüedad PM2/Compose.
- [ ] JuanOS visible como `ESTA APLICACIÓN` y segundo registro rechazado.
- [ ] Estado esperado/observado: aceptar, ignorar y repair.
- [ ] `.env`: scan, validación, reveal, edición y cambio externo.
- [ ] Plan visible y hash idéntico al confirmar.
- [ ] Segundo deploy destructivo bloqueado.
- [ ] Cerrar Safari y volver durante build.
- [ ] Reiniciar API y reconectar al log producido por el worker host.
- [ ] Fallo tras modificación produce `partial`.
- [ ] Git con cambios locales bloquea update.
- [ ] npm/yarn/pnpm sin lockfile fallan de forma segura.
- [ ] PM2 reload y logs.
- [ ] systemd restart/status/journal limitado a la unit configurada.
- [ ] Static release y rollback.
- [ ] Django pip/migrate/collectstatic y backup.
- [ ] Docker build/recreate con labels commit/deployment.
- [ ] Compose pull/build/up/restart/logs sin operaciones destructivas.
- [ ] Puerto ocupado falla antes de iniciar.
- [ ] Process, HTTP y no-verificado se muestran por separado.
- [ ] DNS incorrecto, puerto 80 cerrado y `nginx -t` fallido bloquean SSL.
- [ ] Certbot issue, inventario, días y dry-run.
- [ ] Alertas se abren y resuelven.
- [ ] Recovery crea `.age`, sube, descarga y compara SHA-256.
- [ ] Recovery test valida manifest y `pg_restore --list`.
- [ ] `juanos-recover` funciona con web/API detenidas.
- [ ] Self-update crea recovery, activa release, reinicia API y luego worker.
- [ ] Política/helper/sudoers con owner o mode incorrectos son rechazados.
- [ ] iPhone vertical/horizontal, safe areas y teclado de terminal.

## Verificación realizada

- `npm run lint`: correcto.
- `npm run typecheck`: correcto.
- `npm test`: 34 pruebas correctas tras este incremento.
- `npm run build`: correcto.
- `docker compose config --quiet`: correcto.
- `bash -n scripts/*.sh`: correcto.
- `node --check` sobre los tres helpers Node: correcto.
- Chrome real headless a 390×844 con API interceptada:
  - dashboard `scrollWidth = 390`;
  - detalle `scrollWidth = 390`;
  - wizard de 354 px dentro de viewport de 390 px.
