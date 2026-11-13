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
