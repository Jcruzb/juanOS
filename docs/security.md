# Modelo de seguridad

## Riesgos prioritarios

1. Escape del directorio permitido mediante `..`, enlaces simbólicos o carreras TOCTOU.
2. Ejecución de comandos construidos con datos del cliente.
3. Secuestro de sesión, CSRF o apertura de WebSocket desde otro origen.
4. Shell o Docker con privilegios de root.
5. Filtración de tokens, contraseñas y `.env` en logs.
6. Fuerza bruta contra el único administrador.

## Controles implementados

- Argon2id, sesión opaca hasheada en base de datos, cookie `httpOnly`, `sameSite=strict` y
  `secure` en producción.
- Token CSRF ligado a la sesión y comparación de origen.
- Límite por IP y bloqueo temporal por cuenta tras cinco fallos.
- Inactividad configurable, revocación en logout y auditoría de accesos.
- Validación de ruta contra `PROJECTS_ROOT`, sin confiar en la ruta enviada por el cliente.
- Respuestas de error sin trazas y logs estructurados con redacción.

- Ejecutar PTY como `webterminal`, sin `sudo`, con shell y `cwd` fijados por servidor.
- Resolver rutas con `realpath`; rechazar symlinks fuera de la raíz, `.git`, `.env`, claves y
  binarios grandes.
- Usar `spawn(programa, argumentos)` para Git y listas cerradas para despliegues.
- Autenticar WebSocket con la cookie, validar `Origin`, limitar mensajes y cerrar por inactividad.
- Conservar una PTY desconectada solo 20 segundos, ligada al mismo usuario y proyecto.
- Auditar apertura/cierre de terminal sin almacenar su entrada cruda: un prompt SSH puede
  contener contraseñas, tokens o frases de paso aunque visualmente no muestre los caracteres.
- No montar `/var/run/docker.sock` en API.

## Pendiente de staging

- Verificar que UID/GID y ACL del host limitan cada proyecto como se documenta.
- Instalar ejecutores de despliegue inmutables, uno por slug, y probar reglas específicas de
  systemd o un agente Docker separado.
- Añadir TOTP/passkeys, allowlist de IP y rotación automatizada de sesiones/retención de auditoría.
- Revisar periódicamente dependencias contra el registro de seguridad aprobado por la organización.

## Límites conocidos

Un usuario con terminal puede leer todo lo que el usuario Unix `webterminal` pueda leer. La
seguridad real depende de propietarios, grupos, permisos y montajes del VPS. La auditoría de
comandos de shell es orientativa: puede redactar patrones conocidos, no demostrar ausencia de
secretos.
