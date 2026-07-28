# Arquitectura de JuanOS

JuanOS es un monorepo npm con cuatro fronteras:

- `apps/web`: SPA React/Vite mobile-first. No contiene secretos ni decisiones de autorización.
- `apps/api`: API Express, autenticación, PostgreSQL y auditoría. Es la única puerta de entrada a datos.
- `packages/shared`: esquemas Zod compartidos y contratos de API.
- `packages/config`: validación estricta de configuración al arrancar.

La terminal se ejecuta mediante `node-pty` como el usuario Linux
`webterminal`; conserva temporalmente la PTY en memoria durante cortes breves para permitir
reconexión. Archivos, Git y despliegues pasan por servicios dedicados que vuelven a
comprobar proyecto, usuario y ruta. El navegador nunca decide el usuario Unix, el directorio
base ni los comandos de despliegue.

## Flujo de confianza

Nginx termina TLS y reenvía solo `/api` y `/ws`. La API crea una sesión opaca almacenada en
PostgreSQL, entrega una cookie firmada `httpOnly`, y exige un token CSRF por cabecera en cada
mutación. Las rutas validan con Zod antes de llegar a los servicios.

PostgreSQL conserva configuración, estado, sesiones, despliegues, locks, alertas y auditoría. Los repositorios
se montan explícitamente bajo `/srv/juanos/projects`; nunca se monta el sistema de archivos raíz.

El worker host obtiene rama, commits y procesos mediante invocaciones con argumentos separados.
PM2 se ejecuta como `webterminal`; systemd, Docker, Nginx y Certbot pasan por un helper root-owned
con política por aplicación. Process, HTTP y salud funcional permanecen separados.

## Decisiones

- Se usan sesiones opacas, no JWT en `localStorage`, para poder revocarlas y limitar el daño
  de XSS.
- Los planes solo contienen acciones del catálogo; no aceptan comandos, executable, args o shell.
- El acceso Docker queda fuera de la API. El worker host solo puede invocar acciones Docker
  enumeradas por el helper; montar `docker.sock` en la API equivaldría prácticamente a root.
- API y web publican puertos solo en loopback. Nginx y Certbot viven en el host.
