import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { idSchema } from "@juanos/shared";
import { requireCsrf } from "./auth.js";
import { writeAudit } from "./audit.js";
import { runHostAction } from "./host-operations.js";
import { redactSecrets } from "./security.js";

const createLogSessionSchema = z.object({
  source: z.enum(["pm2", "systemd", "docker_compose", "nginx_access", "nginx_error"]),
  service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/).optional(),
  lines: z.union([z.literal(100), z.literal(500), z.literal(1000)]).default(100),
  follow: z.boolean().default(true)
});

export function createOperationalLogsRouter({ express, db }) {
  const router = express.Router({ mergeParams: true });

  router.get("/sources", async (request, response, next) => {
    try {
      const applicationId = idSchema.parse(request.params.projectId);
      const result = await db.query(
        `SELECT p.id, p.slug, p.service_name AS "serviceName",
         ds.strategy, ds.config,
         COALESCE((
           SELECT json_agg(json_build_object('name', s.name, 'type', s.service_type))
           FROM application_services s WHERE s.application_id = p.id
         ), '[]'::json) AS services
         FROM projects p
         LEFT JOIN deployment_strategies ds ON ds.application_id = p.id
         WHERE p.id = $1 AND p.is_active = true`,
        [applicationId]
      );
      const application = result.rows[0];
      if (!application) throw Object.assign(new Error("Aplicación no encontrada"), { status: 404 });
      response.json({ sources: availableSources(application) });
    } catch (error) { next(error); }
  });

  router.post("/sessions", requireCsrf, async (request, response, next) => {
    try {
      const applicationId = idSchema.parse(request.params.projectId);
      const input = createLogSessionSchema.parse(request.body);
      const applicationResult = await db.query(
        `SELECT p.id, p.slug, p.service_name AS "serviceName", ds.strategy, ds.config
         FROM projects p LEFT JOIN deployment_strategies ds ON ds.application_id = p.id
         WHERE p.id = $1 AND p.is_active = true`,
        [applicationId]
      );
      const application = applicationResult.rows[0];
      if (!application) throw Object.assign(new Error("Aplicación no encontrada"), { status: 404 });
      const sources = availableSources(application);
      if (!sources.some((source) => source.id === input.source)) {
        throw Object.assign(new Error("Fuente de logs no configurada para la aplicación"), {
          status: 409,
          code: "LOG_SOURCE_NOT_CONFIGURED"
        });
      }
      const allowedServices = new Set([
        application.serviceName,
        application.config?.processName,
        application.config?.serviceName,
        ...(application.config?.services || [])
      ].filter(Boolean));
      if (input.service && !allowedServices.has(input.service)) {
        throw Object.assign(new Error("Servicio de logs no autorizado"), { status: 400 });
      }
      const created = await db.query(
        `INSERT INTO operational_log_sessions
          (application_id, user_id, source, service_name, line_limit, follow)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, status, expires_at AS "expiresAt"`,
        [applicationId, request.user.id, input.source, input.service || null, input.lines, input.follow]
      );
      await writeAudit(db, request, {
        action: "logs.opened",
        resourceType: "operational_log_session",
        resourceId: created.rows[0].id,
        metadata: { applicationId, source: input.source, lines: input.lines }
      });
      response.status(201).json(created.rows[0]);
    } catch (error) { next(error); }
  });

  router.post("/sessions/:sessionId/cancel", requireCsrf, async (request, response, next) => {
    try {
      const applicationId = idSchema.parse(request.params.projectId);
      const sessionId = idSchema.parse(request.params.sessionId);
      const result = await db.query(
        `UPDATE operational_log_sessions SET status = 'cancelled', finished_at = now()
         WHERE id = $1 AND application_id = $2 AND user_id = $3
           AND status IN ('queued', 'running') RETURNING id`,
        [sessionId, applicationId, request.user.id]
      );
      if (!result.rows[0]) throw Object.assign(new Error("Sesión de logs no cancelable"), { status: 409 });
      response.status(204).end();
    } catch (error) { next(error); }
  });
  return router;
}

function availableSources(application) {
  const sources = [];
  if (application.strategy === "pm2") sources.push({ id: "pm2", label: "PM2", service: application.config?.processName });
  if (application.strategy === "systemd") sources.push({ id: "systemd", label: "systemd", service: application.config?.serviceName || application.serviceName });
  if (application.strategy === "docker_compose") sources.push({ id: "docker_compose", label: "Docker Compose", services: application.config?.services || [] });
  if (application.config?.nginx?.enabled) {
    sources.push({ id: "nginx_access", label: "Nginx access" });
    sources.push({ id: "nginx_error", label: "Nginx error" });
  }
  return sources;
}

async function claimLogSession(db, workerId) {
  return db.transaction(async (transaction) => {
    const selected = await transaction.query(
      `SELECT ls.id, ls.application_id AS "applicationId", ls.source,
       ls.service_name AS "requestedService", ls.line_limit AS lines, ls.follow,
       p.slug, p.local_path AS "localPath", p.service_name AS "serviceName",
       ds.strategy, ds.config
       FROM operational_log_sessions ls
       JOIN projects p ON p.id = ls.application_id
       LEFT JOIN deployment_strategies ds ON ds.application_id = p.id
       WHERE ls.status = 'queued' AND ls.expires_at > now()
       ORDER BY ls.created_at FOR UPDATE OF ls SKIP LOCKED LIMIT 1`
    );
    const session = selected.rows[0];
    if (!session) return null;
    await transaction.query(
      `UPDATE operational_log_sessions SET status = 'running', claimed_by = $2,
       started_at = now(), log_path = $3 WHERE id = $1`,
      [session.id, workerId, `operations/${session.id}.log`]
    );
    return session;
  });
}

function spawnLogCommand(executable, args, options, append) {
  const child = spawn(executable, args, { ...options, shell: false });
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return child;
}

async function executeLogSession(session, config, append) {
  const lines = String(session.lines);
  if (session.source === "pm2") {
    const processName = session.requestedService || session.config?.processName || session.slug;
    const args = ["logs", processName, "--lines", lines, "--raw"];
    if (!session.follow) args.push("--nostream");
    return spawnLogCommand("pm2", args, { cwd: session.localPath }, append);
  }
  const actionMap = {
    systemd: "systemd-logs",
    docker_compose: "compose-logs",
    nginx_access: "nginx-logs",
    nginx_error: "nginx-logs"
  };
  const parameters = { lines, follow: session.follow };
  if (session.source === "systemd") {
    parameters.service = session.requestedService || session.config?.serviceName || session.serviceName;
  }
  if (session.source === "docker_compose") {
    parameters["compose-file"] = session.config?.composeFile || "compose.yml";
    parameters["compose-service"] = session.requestedService;
  }
  if (session.source.startsWith("nginx_")) parameters.source = session.source.slice("nginx_".length);
  let child;
  await runHostAction({
    config,
    deployment: session,
    action: actionMap[session.source],
    parameters,
    run(executable, args, options) {
      child = spawnLogCommand(executable, args, options, append);
      return child;
    }
  });
  return child;
}

export async function runOperationalLogWorkerOnce({ db, config, workerId }) {
  const session = await claimLogSession(db, workerId);
  if (!session) return false;
  const directory = path.join(config.DEPLOY_LOGS_DIR, "operations");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const filePath = path.join(directory, `${session.id}.log`);
  const handle = await fs.open(filePath, "a", 0o600);
  await handle.chmod(0o600);
  let queue = Promise.resolve();
  const append = (chunk) => {
    const clean = redactSecrets(String(chunk));
    queue = queue.then(() => handle.appendFile(clean, "utf8"));
  };
  let child;
  let timeout;
  let poll;
  let finalStatus = "finished";
  let finalError = null;
  try {
    child = await executeLogSession(session, config, append);
    if (!child) throw new Error("No se pudo iniciar la fuente de logs");
    timeout = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
    timeout.unref();
    poll = setInterval(async () => {
      const result = await db.query("SELECT status FROM operational_log_sessions WHERE id = $1", [session.id]);
      if (result.rows[0]?.status === "cancelled") child.kill("SIGTERM");
    }, 1000);
    poll.unref();
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === 0 || signal === "SIGTERM") resolve();
        else reject(Object.assign(new Error(`Fuente de logs terminó con código ${code}`), { exitCode: code }));
      });
    });
  } catch (error) {
    finalStatus = "failed";
    finalError = redactSecrets(error.message).slice(0, 1000);
    append(`\nError: ${finalError}\n`);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (poll) clearInterval(poll);
    await queue;
    await handle.close();
    await db.query(
      `UPDATE operational_log_sessions SET
       status = CASE WHEN status = 'cancelled' THEN status ELSE $2 END,
       error = $3, finished_at = now() WHERE id = $1`,
      [session.id, finalStatus, finalError]
    );
  }
  return true;
}

export function startOperationalLogWorker({ db, config }) {
  const workerId = `logs-${process.pid}`;
  let stopped = false;
  let timer;
  const tick = async () => {
    if (stopped) return;
    try {
      const handled = await runOperationalLogWorkerOnce({ db, config, workerId });
      timer = setTimeout(tick, handled ? 50 : 1000);
    } catch {
      timer = setTimeout(tick, 3000);
    }
    timer.unref();
  };
  db.query(
    `UPDATE operational_log_sessions SET status = 'failed',
     error = 'El worker anterior se interrumpió', finished_at = now()
     WHERE status = 'running'`
  ).finally(tick);
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export { availableSources, createLogSessionSchema };
