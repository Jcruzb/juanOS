# Resolución de problemas

## La API no arranca

Comprueba `docker compose ps` y los logs del servicio `api`. Las causas frecuentes son una
contraseña de base de datos distinta, `SESSION_SECRET` menor de 32 caracteres o una ruta de
proyectos ausente.

## Bucle de inicio de sesión

La cookie `secure` exige HTTPS en producción. Confirma que Nginx envía
`X-Forwarded-Proto: https`, que `APP_ORIGIN` coincide exactamente con el dominio y que la hora
del VPS está sincronizada.

## 403 al guardar

Recarga la página para obtener un token CSRF nuevo. Un origen distinto, una sesión caducada o
una pestaña muy antigua provocan el rechazo.

## Permiso denegado en un proyecto

No amplíes permisos globalmente. Comprueba propietario y grupo del repositorio y concede acceso
solo al grupo `webterminal`. No añadas el usuario a `sudo` ni al grupo `docker`.

## La terminal no abre

Comprueba que la imagen de API incluye `node-pty`, que el proyecto existe dentro de `/srv/juanos/projects`
y que el contenedor se ejecuta con UID/GID 1100. Un origen distinto de `APP_ORIGIN` o una cookie
caducada hacen que el WebSocket se rechace antes de crear la shell.

## Conexiones SSH

La terminal incluye OpenSSH Client y conserva `~/.ssh` en el volumen `terminal_home`. Conecta con
`ssh usuario@servidor`; verifica siempre la huella del host antes de aceptarla. Las contraseñas y
frases de paso se introducen directamente en el prompt y no se guardan en la base de datos ni en
la auditoría. No montes claves privadas de otros usuarios del host dentro del contenedor.

## Certificado

El primer certificado debe existir antes de arrancar la configuración HTTPS. Si el puerto 80
está ocupado, detén temporalmente solo el proxy, solicita/renueva el certificado y vuelve a
iniciarlo.
