import argon2 from "argon2";
import { loginSchema } from "@juanos/shared";
import { hashToken, randomToken, requestIp, timingSafeEqual } from "./security.js";
import { writeAudit } from "./audit.js";

const SESSION_COOKIE = "juanos_session";
const CSRF_COOKIE = "juanos_csrf";
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const dummyPasswordHash = argon2.hash(randomToken(), { type: argon2.argon2id });

function cookieOptions(config) {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: config.SESSION_IDLE_MINUTES * 60_000
  };
}

function csrfCookieOptions(config) {
  return {
    httpOnly: false,
    secure: config.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: config.SESSION_IDLE_MINUTES * 60_000
  };
}

export function createAuthRouter({ express, db, config, loginLimiter }) {
  const router = express.Router();

  router.get("/csrf", requireSession(db, config), (request, response) => {
    response.json({ csrfToken: request.session.csrfToken });
  });

  router.post("/login", loginLimiter, async (request, response, next) => {
    try {
      const input = loginSchema.parse(request.body);
      const result = await db.query(
        `SELECT id, email, password_hash, role, is_active, failed_login_count, locked_until
         FROM users WHERE email = $1`,
        [input.email]
      );
      const user = result.rows[0];
      const locked = user?.locked_until && new Date(user.locked_until) > new Date();
      const passwordMatches = await argon2.verify(user?.password_hash || await dummyPasswordHash, input.password);
      const valid = user && user.is_active && !locked && passwordMatches;

      if (!valid) {
        if (user && !locked) {
          const failures = Number(user.failed_login_count) + 1;
          await db.query(
            `UPDATE users SET failed_login_count = $2,
             locked_until = CASE WHEN $2 >= $3 THEN now() + ($4 || ' minutes')::interval ELSE NULL END,
             updated_at = now() WHERE id = $1`,
            [user.id, failures, MAX_FAILURES, LOCK_MINUTES]
          );
        }
        await writeAudit(db, request, {
          userId: user?.id,
          action: "auth.login_failed",
          resourceType: "user",
          resourceId: user?.id,
          metadata: { reason: locked ? "locked" : "invalid_credentials" }
        });
        return response.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Credenciales no válidas" } });
      }

      const token = randomToken();
      const csrfToken = randomToken();
      await db.transaction(async (transaction) => {
        await transaction.query(
          `INSERT INTO app_sessions
           (user_id, token_hash, csrf_token_hash, remote_ip, user_agent, expires_at)
           VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::interval)`,
          [user.id, hashToken(token), hashToken(csrfToken), requestIp(request), request.get("user-agent"), config.SESSION_IDLE_MINUTES]
        );
        await transaction.query(
          "UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now(), updated_at = now() WHERE id = $1",
          [user.id]
        );
      });

      response.cookie(SESSION_COOKIE, token, cookieOptions(config));
      response.cookie(CSRF_COOKIE, csrfToken, csrfCookieOptions(config));
      request.user = { id: user.id };
      await writeAudit(db, request, {
        action: "auth.login_succeeded",
        resourceType: "user",
        resourceId: user.id,
        metadata: {}
      });
      response.json({ user: { id: user.id, email: user.email, role: user.role }, csrfToken });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", requireSession(db, config), requireCsrf, async (request, response, next) => {
    try {
      await db.query("UPDATE app_sessions SET revoked_at = now() WHERE id = $1", [request.session.id]);
      await writeAudit(db, request, {
        action: "auth.logout",
        resourceType: "session",
        resourceId: request.session.id,
        metadata: {}
      });
      response.clearCookie(SESSION_COOKIE, cookieOptions(config));
      response.clearCookie(CSRF_COOKIE, csrfCookieOptions(config));
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", requireSession(db, config), (request, response) => {
    response.json({ user: request.user, csrfToken: request.session.csrfToken });
  });

  return router;
}

export function requireSession(db, config) {
  return async (request, response, next) => {
    try {
      const token = request.cookies?.[SESSION_COOKIE];
      if (!token) return response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Inicia sesión" } });
      const result = await db.query(
        `SELECT s.id, s.csrf_token_hash, s.last_seen_at, u.id AS user_id, u.email, u.role
         FROM app_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active = true`,
        [hashToken(token)]
      );
      const row = result.rows[0];
      if (!row) return response.status(401).json({ error: { code: "SESSION_EXPIRED", message: "La sesión ha expirado" } });
      const idleMs = Date.now() - new Date(row.last_seen_at).getTime();
      if (idleMs > config.SESSION_IDLE_MINUTES * 60_000) {
        await db.query("UPDATE app_sessions SET revoked_at = now() WHERE id = $1", [row.id]);
        return response.status(401).json({ error: { code: "SESSION_IDLE", message: "La sesión ha expirado por inactividad" } });
      }
      const csrfToken = request.cookies?.[CSRF_COOKIE] || "";
      request.user = { id: row.user_id, email: row.email, role: row.role };
      request.session = { id: row.id, csrfToken, csrfTokenHash: row.csrf_token_hash };
      await db.query(
        `UPDATE app_sessions SET last_seen_at = now(),
         expires_at = now() + ($2 || ' minutes')::interval WHERE id = $1`,
        [row.id, config.SESSION_IDLE_MINUTES]
      );
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireCsrf(request, response, next) {
  const origin = request.get("origin");
  const expectedOrigin = `${request.protocol}://${request.get("host")}`;
  if (origin && origin !== expectedOrigin && origin !== request.app.locals.config.APP_ORIGIN) {
    return response.status(403).json({ error: { code: "BAD_ORIGIN", message: "Origen no permitido" } });
  }
  const token = request.get("x-csrf-token") || "";
  if (!token || !timingSafeEqual(hashToken(token), request.session.csrfTokenHash)) {
    return response.status(403).json({ error: { code: "CSRF_INVALID", message: "Token CSRF no válido" } });
  }
  next();
}
