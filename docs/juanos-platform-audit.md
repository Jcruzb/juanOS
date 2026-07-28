# Auditoría de evolución de JuanOS

Fecha: 2026-07-28

## Alcance y método

Esta auditoría se realizó antes de modificar el código de JuanOS. Se revisó el árbol completo
del repositorio, su configuración de contenedores, migraciones, API, SPA, WebSockets, scripts,
tests y documentación. También se revisó el repositorio histórico `deploy-app` (JC-Deploy),
incluyendo sus comandos, servicios, plantillas y tests.

La inspección describe lo que está versionado. No demuestra el estado de una VPS concreta:
procesos, unidades systemd, certificados, permisos efectivos, DNS, firewall y renovaciones deben
validarse en staging y luego en producción.

## Estado actual de JuanOS

JuanOS es un monorepo npm ESM para Node.js 22:

- `apps/web`: React 19, Vite, TanStack Query, xterm.js y Monaco.
- `apps/api`: Express 5, PostgreSQL (`pg`), Argon2id, sesiones opacas, Zod, WebSocket y node-pty.
- `packages/shared`: validación de contratos con Zod.
- `packages/config`: validación estricta de variables de proceso.
- `infra`: Nginx, Dockerfiles y entrypoint de API.
- `scripts`: preparación de Ubuntu, Docker, entorno, verificación y ejecutor de ejemplo.

El repositorio inspeccionado no tiene un commit inicial en la rama `main`: todos los archivos
aparecen como no rastreados. Esto impide usar Git para atribuir o comparar cambios previos y hace
especialmente importante no eliminar ni reemplazar el esqueleto existente.

### Arquitectura encontrada

```text
Safari / navegador
  ├─ HTTPS ────────────────> Nginx
  │                            ├─ /       -> SPA estática
  │                            └─ /api    -> Express
  └─ WebSocket ────────────> Nginx
                               ├─ /ws/terminal    -> node-pty
                               └─ /ws/deployments -> stream en memoria

Express
  ├─ Auth y sesiones ──────> PostgreSQL
  ├─ Projects ─────────────> PostgreSQL + Git
  ├─ Files/Git ────────────> rutas bajo PROJECTS_ROOT
  ├─ Deployments ──────────> script root-owned por slug
  └─ Audit ────────────────> PostgreSQL
```

No hay microservicios. API, frontend, PostgreSQL y proxy se despliegan con Docker Compose.
La API se ejecuta dentro del contenedor como `webterminal` (UID/GID 1100), sin capabilities y
con `no-new-privileges`. Los proyectos se montan bajo `/workspace`; no se monta `/`, ni
`docker.sock`. El frontend se sirve desde un contenedor Nginx de solo lectura.

### Autenticación y seguridad

Ya existe una base correcta:

- Hash Argon2id.
- Sesión opaca revocable almacenada en PostgreSQL.
- Cookies `SameSite=Strict`; la cookie de sesión es `httpOnly` y `secure` en producción.
- CSRF por token de sesión en todas las mutaciones existentes.
- Bloqueo temporal tras cinco fallos y rate limiting específico de login.
- Comparaciones constantes de tokens y almacenamiento de hashes, no tokens en claro.
- Helmet, límites de body y redacción de contraseña/cookies en logs HTTP.
- Origen WebSocket exacto y autenticación antes de abrir PTY o logs.
- Resolución con `realpath`, control de symlinks y bloqueo de `.env`, claves privadas y traversal
  en el editor general.
- Git y despliegues usan ejecutable y argumentos separados, con `shell: false`.

Riesgos y huecos:

- La CSP de Express está desactivada; Nginx sí añade CSP. El modo de desarrollo no la reproduce.
- No hay MFA/passkeys, allowlist de IP ni reautenticación para acciones sensibles.
- La sesión se actualiza por actividad, pero falta una expiración absoluta independiente.
- La autorización WebSocket de despliegues valida una sesión válida, pero no liga explícitamente
  el despliegue a su usuario (aceptable con un único administrador, mejorable).
- La redacción actual es heurística y no conoce todavía valores reales de entornos.
- No existe un modelo de privilegios por operación ni un canal seguro para sudo.
- El contenedor API no tiene acceso a PM2/systemd/Nginx/Docker del host. Esto es deliberadamente
  seguro, pero exige un worker/agente limitado o helpers root-owned para operar el host.

### PostgreSQL

La migración inicial contiene:

- `users`
- `projects`
- `app_sessions`
- `terminal_sessions`
- `deployments`
- `audit_logs`

Hay un índice parcial que impide dos despliegues `queued/running` por proyecto. PostgreSQL ya es
fuente de verdad para autenticación, proyectos, despliegues y auditoría, pero faltan repositorios,
estrategias, servicios, entornos, pasos, alertas, certificados, recovery y locks explícitos.

El migrador aplica archivos SQL ordenados dentro de transacciones y registra
`schema_migrations`, por lo que el modelo se puede ampliar incrementalmente.

### Terminal, archivos y Git

La terminal actual es una PTY real y se conserva. Se abre en el `local_path` registrado, nunca
como root, restringe entorno y tamaño de mensajes, y audita apertura/cierre/duración. Mantiene
sesiones PTY en memoria durante un periodo de gracia para reconectar.

El explorador y Monaco ya incluyen protección de rutas, concurrencia optimista por hash,
búsqueda acotada, creación/renombrado/borrado y Git cerrado (`fetch`, `pull --ff-only`, `push`,
stage, unstage, commit y ramas). `.env` está correctamente excluido del editor genérico; debe
tener un flujo especializado con revelado y auditoría.

### Despliegues y logs

El despliegue actual:

1. obtiene rama y `HEAD`;
2. inserta un registro `queued`;
3. ejecuta inmediatamente un único script cuyo nombre deriva de un slug validado;
4. exige archivo no escribible por grupo/otros y ownership root en producción;
5. transmite salida por un `Map` en memoria;
6. guarda un resumen en PostgreSQL.

Es un buen límite de seguridad, pero no satisface todavía la plataforma objetivo:

- la ejecución está desacoplada de la respuesta HTTP, pero no es recuperable tras reiniciar API;
- no hay plan visible/inmutable ni confirmación separada;
- no hay pasos persistidos;
- el stream completo se pierde al reiniciar;
- no hay log local con permisos privados;
- no distingue `failed` de `partial`;
- no hay health check, rollback, backup ni commit desplegado real;
- el lock parcial depende del índice de estados y no recupera huérfanos;
- PM2/systemd/Nginx/Docker no tienen adaptadores de logs.

### Despliegue e infraestructura

El modo documentado es Docker Compose:

- PostgreSQL 17.6 Alpine con volumen y health check.
- API sin privilegios, proyectos y ejecutores montados explícitamente.
- Web de solo lectura.
- Nginx de borde con TLS 1.2/1.3, HSTS, CSP, límites y rutas protegidas.
- reinicio `unless-stopped`.

`prepare-server.sh` crea `webterminal`, `/srv/juanos/projects` y `/opt/juanos`, sin añadir sudo.
El ejecutor de ejemplo usa `git pull`, Docker Compose o un helper systemd exacto. No hay unidad
systemd de JuanOS, arquitectura de releases, instalación de Certbot, timer de renovación ni
script externo de recovery. El primer certificado debe prepararse fuera del compose.

### Tests y UX móvil

Hay tests útiles de auth, cookies, bloqueo de traversal, symlinks, redacción, Git, origen WS,
PTY real simulada, ejecutores y lock parcial. Faltan las pruebas específicas enumeradas en la
especificación.

La SPA ya es mobile-first: navegación inferior, safe areas, botones táctiles, terminal a pantalla
completa, teclas móviles y drawer de archivos. El dashboard usa datos reales cuando existen,
pero aún conserva datos de muestra como fallback y no tiene detalle operativo por aplicación,
alertas, variables, SSL, servicios ni recovery.

## Auditoría de JC-Deploy

JC-Deploy es una CLI CommonJS de unas 4.500 líneas con `commander`, `inquirer`, `execa`,
`fs-extra`, `ora`, `chalk` y `boxen`. Su fuente de verdad es `.jc-deploy.json` más
`~/.jc-deploy/apps.json`.

Capacidades encontradas:

- Descubrimiento desde `/home/<usuario>/apps`, metadata, Git, package.json, PM2, Nginx y
  pistas bajo `/var/www`.
- Inferencia front/back/fullstack/Django, gestores de paquetes, comandos build/start,
  carpetas publicadas, puertos, PM2 y systemd.
- `status`, `preflight` y `doctor` con evidencia de Git, package, `.env`, PM2, Nginx, Certbot y
  binarios.
- `update`, `repair`, `restart` y `logs`.
- Despliegues frontend, backend y fullstack.
- Plantillas Nginx y PM2.
- Certbot con comprobación DNS.
- `rsync` para publicar frontend y marcador de commit desplegado en metadata.
- Runner con `execa`, timeout y `shell: false`.
- `sudo -v` y keepalive durante una ejecución CLI.
- Estado `partial`, último paso/error y tests de metadata, plantillas, comandos y validadores.

### Clasificación

| Pieza JC-Deploy | Clasificación | Destino en JuanOS |
|---|---|---|
| Validadores de repo, dominio, puerto y nombres | Reutilizable casi sin cambios conceptuales | Esquemas Zod y funciones puras |
| Detección de lockfile/scripts/package manager | Reutilizable casi sin cambios | Inspector de proyecto |
| Inferencia Django y `STATIC_ROOT` | Reutilizable casi sin cambios | Inspector Django |
| Plantillas Nginx/PM2 | Reutilizable con refactor | Plantillas tipadas + preview/plan |
| Descubrimiento Git/package/PM2/Nginx/`/var/www` | Reutilizable con refactor | Evidencias estructuradas, sin prompts |
| Preflight/doctor/puertos/DNS | Reutilizable con refactor | Checks con códigos y severidad |
| Git seguro y timeout | Reutilizable con refactor | Adaptador de procesos y pasos |
| Update/repair/restart | Funcionalidad a reescribir | Planes inmutables y worker persistente |
| Front/back/fullstack/Django deploy | Funcionalidad a reescribir | Generadores de plan por estrategia |
| Nginx/Certbot/rsync/PM2/systemd | Funcionalidad a reescribir | Acciones cerradas de worker/helper |
| `Runner`/`execa` | Reutilizable con refactor | Runner sin UI, eventos y redacción |
| `.jc-deploy.json` y `apps.json` | Solo importación | Importador one-shot a PostgreSQL |
| `inquirer`, `commander`, logger visual | No reutilizable | Formularios React y eventos API |
| sudo CLI con ticket global/keepalive | No reutilizable tal cual | Autorización ligada a una operación |

JC-Deploy mezcla en varios servicios detección, escritura, salida de consola y preguntas. No se
copiarán esos módulos literalmente: se preservan reglas funcionales, mientras prompts pasan a
contratos, logs a eventos y errores a objetos con código, paso, detalle seguro y posibilidad de
reintento.

## Mapa JuanOS ↔ JC-Deploy

| Necesidad | JuanOS actual | JC-Deploy | Evolución |
|---|---|---|---|
| Auth/sesiones/auditoría | Sólido | No aplica | Conservar y ampliar acciones |
| Terminal | Sólido | No aplica | Conservar, añadir contexto de app |
| Catálogo de apps | `projects` básico | Índice JSON | Ampliar `projects`, PostgreSQL único |
| Descubrimiento/import | No existe | Amplio | Migrar como evidencias + confirmación |
| Git | Operaciones cerradas | Inspect/update | Compartir runner y separar commits |
| Deploy | Script por slug | Flujos completos | Plan + pasos + worker persistente |
| Logs | Deploy en memoria | PM2 básico | Adaptadores limitados + log local |
| Entornos | Bloqueados en editor | Inspección mínima | Parser preservante y workflow propio |
| PM2/systemd | Solo metadata | Implementado | Acciones cerradas del worker |
| Nginx/Certbot | Solo proxy JuanOS | Implementado | Preview, validación, helpers limitados |
| Docker | Compose de JuanOS | No real | Detección y acciones cerradas |
| Health/alerts | No | Parcial | Modelo explícito y checks |
| Recovery | No | No | Nuevo diseño cifrado y externo |

## Decisiones técnicas

1. **No renombrar ni duplicar `projects` inmediatamente.** Será el agregado equivalente a
   `Application`, con columnas nuevas y tablas `repositories`, `deployment_strategies`,
   `application_services`, `environments`, etc. Así terminal, archivos y Git siguen funcionando.
2. **PostgreSQL es la única fuente de verdad tras importar.** Los JSON históricos se leen, se
   conserva su procedencia y fingerprint, pero nunca se vuelven a escribir.
3. **Monolito modular + worker dentro del mismo despliegue.** Un proceso worker separado del API
   puede compartir paquete y base de datos; no se introduce Redis.
4. **Planes declarativos y acciones cerradas.** Ningún endpoint acepta shell arbitrario. Los
   pasos contienen `action`, argumentos validados y metadata segura.
5. **Estado esperado y observado separados.** La configuración vive en PostgreSQL; inspectores
   escriben snapshots observados. Las divergencias no se corrigen sin confirmación.
6. **Secretos fuera de PostgreSQL inicialmente.** Se guarda metadata/fingerprint; el valor real
   permanece en el archivo y solo se revela mediante endpoint explícito auditado.
7. **Host privilegiado detrás de una frontera explícita.** La API no recibe `docker.sock` ni sudo
   general. PM2/systemd/Nginx/Certbot/Docker requieren worker en host o helpers root-owned con
   allowlist.
8. **JuanOS se protege a sí mismo.** `is_juanos` impide borrar/desregistrar/detener y exige
   recovery previo para actualizar.
9. **Recovery independiente.** `juanos-recover` no depende de la API; snapshots usan bundle,
   checksum, cifrado previo y proveedor remoto abstraído (inicialmente rclone).

## Riesgos principales

- Dar al contenedor acceso directo a Docker o sudo equivaldría a elevar la API casi a root.
- Un worker persistente mal diseñado podría ejecutar planes manipulados; se requiere catálogo de
  acciones, validación de versión y plan inmutable.
- Los despliegues frontend pueden confundir `HEAD` con artefacto publicado; se necesita marcador.
- Reiniciar JuanOS desde sí mismo puede cortar la confirmación; necesita release preparada,
  respuesta previa, supervisor externo y health posterior.
- El parsing/modificación de `.env` puede destruir formato o filtrar secretos; debe conservar
  líneas y revelar valores individualmente.
- Inferencias de PM2/Nginx/Docker pueden colisionar; la importación debe representar ambigüedad.
- La operación en una VPS real no puede validarse solo con tests unitarios locales.
- Recovery sin prueba periódica crea una falsa sensación de seguridad.

## Plan incremental

### Fase 1: base de plataforma

- ampliar modelo PostgreSQL y migraciones;
- introducir contratos de inspector, importador, plan y pasos;
- persistir planes, pasos, locks y logs referenciados;
- mantener compatibilidad con proyectos y terminal existentes.

### Fase 2: catálogo y descubrimiento

- inspección de Git/package/Docker/.env;
- importación de `.jc-deploy.json` y `apps.json`;
- evidencias `confirmed/probable/ambiguous/not_detected`;
- dashboard y detalle con `isJuanOS`, expected/observed.

### Fase 3: observabilidad

- adaptadores de PM2, systemd, Nginx, Docker y deploy;
- streams reconectables desde archivo;
- health checks y alertas.

### Fase 4: entornos

- parser preservante, fingerprints, revisión/revelado auditado;
- metadata build/runtime/both y edición atómica.

### Fases 5–9: operación

- worker PostgreSQL, locks y recuperación;
- update/preflight y commits separados;
- wizards front/back/fullstack/Django;
- Docker/Compose;
- certificados, DNS y dry-run.

### Fases 10–11: recovery y hardening

- script externo, bundles cifrados, rclone y verificación;
- tests obligatorios, staging, permisos Unix, mobile QA y E2E.

Cada fase debe terminar con lint, typecheck, tests y build. Las operaciones de host no se
considerarán verificadas hasta ejecutarlas en una VPS de staging con la misma topología.
