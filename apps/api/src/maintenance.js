import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { parseCertbotCertificates } from "./certificates.js";
import { runHostAction } from "./host-operations.js";
import { runGit } from "./git.js";

export async function observeDisk(db, projectsRoot) {
  const stats = await fs.statfs(projectsRoot);
  const total = Number(stats.blocks) * Number(stats.bsize);
  const available = Number(stats.bavail) * Number(stats.bsize);
  const usedPercent = total > 0 ? Math.round(((total - available) / total) * 1000) / 10 : 0;
  const status = usedPercent >= 95 ? "critical" : usedPercent >= 85 ? "warning" : "ok";
  await db.query(
    `INSERT INTO system_observations (kind, status, value)
     VALUES ('disk',$1,$2::jsonb)`,
    [status, JSON.stringify({ path: projectsRoot, total, available, usedPercent })]
  );
  return { status, total, available, usedPercent };
}

export async function inspectCertificates(db, config) {
  if (!config.JUANOS_HOST_HELPER) return [];
  const application = await db.query(
    `SELECT id AS "applicationId", slug FROM projects
     WHERE is_active = true ORDER BY is_juanos DESC, created_at LIMIT 1`
  );
  if (!application.rows[0]) return [];
  let stdout = "";
  await runHostAction({
    config,
    deployment: application.rows[0],
    action: "certbot-certificates",
    run(executable, args, options) {
      return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { ...options, shell: false });
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-1_000_000); });
        child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-100_000); });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `Certbot ${code}`)));
      });
    }
  });
  const certificates = parseCertbotCertificates(stdout);
  for (const certificate of certificates) {
    for (const domain of certificate.domains) {
      await db.query(
        `INSERT INTO certificates
          (application_id, domain, issuer, expires_at, auto_renew_configured, observed_at)
         SELECT ad.application_id, ad.hostname, $2, $3, true, now()
         FROM application_domains ad WHERE ad.hostname = $1
         ON CONFLICT (application_id, domain) DO UPDATE SET
          issuer = EXCLUDED.issuer, expires_at = EXCLUDED.expires_at,
          auto_renew_configured = EXCLUDED.auto_renew_configured,
          observed_at = now(), updated_at = now()`,
        [domain, certificate.issuer, certificate.expiresAt]
      );
    }
  }
  return certificates;
}

export async function inspectApplications(db, config) {
  const result = await db.query(
    `SELECT p.id AS "applicationId", p.slug, p.local_path AS "localPath",
     p.service_name AS "serviceName", p.default_branch AS "defaultBranch",
     ds.strategy, ds.config
     FROM projects p JOIN deployment_strategies ds ON ds.application_id = p.id
     WHERE p.is_active = true ORDER BY p.name`
  );
  const observations = [];
  for (const application of result.rows) {
    await inspectRepository(db, application).catch(() => {});
    try {
      const output = await inspectProcess(application, config);
      await db.query(
        `UPDATE projects SET process_status = 'online',
         status = CASE WHEN http_health_status = 'unhealthy' THEN 'degraded' ELSE 'online' END,
         observed_state = observed_state || $2::jsonb, observed_at = now(),
         last_inspected_at = now(), updated_at = now() WHERE id = $1`,
        [
          application.applicationId,
          JSON.stringify({ process: { status: "online", detail: output.trim().slice(-2000) } })
        ]
      );
      observations.push({ applicationId: application.applicationId, status: "online" });
    } catch (error) {
      await db.query(
        `UPDATE projects SET process_status = 'offline', status = 'offline',
         observed_state = observed_state || $2::jsonb, observed_at = now(),
         last_inspected_at = now(), updated_at = now() WHERE id = $1`,
        [
          application.applicationId,
          JSON.stringify({ process: { status: "offline", detail: error.message.slice(-1000) } })
        ]
      );
      observations.push({ applicationId: application.applicationId, status: "offline" });
    }
  }
  return observations;
}

async function inspectRepository(db, application) {
  await runGit(application.localPath, ["fetch", "--prune", "origin"]);
  const [branch, head, remote, status] = await Promise.all([
    runGit(application.localPath, ["branch", "--show-current"]),
    runGit(application.localPath, ["rev-parse", "HEAD"]),
    runGit(application.localPath, ["rev-parse", `origin/${application.defaultBranch}`]),
    runGit(application.localPath, ["status", "--porcelain=v1"])
  ]);
  const repository = {
    branch: branch.stdout.trim(),
    repositoryCommitSha: head.stdout.trim(),
    remoteCommitSha: remote.stdout.trim(),
    localChanges: Boolean(status.stdout.trim())
  };
  await db.transaction(async (transaction) => {
    await transaction.query(
      `UPDATE repositories SET current_branch = $2, last_remote_commit_sha = $3,
       last_fetched_at = now(), updated_at = now() WHERE application_id = $1`,
      [application.applicationId, repository.branch, repository.remoteCommitSha]
    );
    await transaction.query(
      `UPDATE projects SET observed_state = observed_state || $2::jsonb,
       observed_at = now(), last_inspected_at = now() WHERE id = $1`,
      [application.applicationId, JSON.stringify({ repository })]
    );
  });
  return repository;
}

async function inspectProcess(application, config) {
  if (application.strategy === "static_nginx") {
    await fs.access(application.localPath);
    return "directorio disponible";
  }
  if (application.strategy === "pm2") {
    const processName = application.config?.processName || application.serviceName || application.slug;
    return captureCommand("pm2", ["describe", processName, "--no-color"], { cwd: application.localPath });
  }
  const definitions = {
    systemd: {
      action: "systemd-status",
      parameters: { service: application.config?.serviceName || application.serviceName }
    },
    docker: {
      action: "docker-status",
      parameters: { container: application.config?.containerName || application.slug }
    },
    docker_compose: {
      action: "compose-status",
      parameters: {
        "compose-file": application.config?.composeFile || "compose.yml",
        "compose-service": application.config?.mainService
      }
    }
  };
  const definition = definitions[application.strategy];
  if (!definition) throw new Error("Estrategia no observable");
  let output = "";
  await runHostAction({
    config,
    deployment: application,
    action: definition.action,
    parameters: definition.parameters,
    run(executable, args, options) {
      return captureCommand(executable, args, options).then((value) => {
        output = value;
      });
    }
  });
  return output;
}

function captureCommand(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk).slice(-100_000); });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-100_000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `${executable} ${code}`)));
  });
}

export async function reconcileAlerts(db) {
  await db.transaction(async (transaction) => {
    await upsertApplicationAlerts(transaction, {
      kind: "app_offline",
      severity: "'critical'",
      title: "'Aplicación offline'",
      detail: "'El proceso principal no está activo'",
      from: "projects p",
      where: "p.process_status = 'offline'",
      application: "p.id"
    });
    await upsertApplicationAlerts(transaction, {
      kind: "ssl_expiring",
      severity: `CASE WHEN c.expires_at <= now() + interval '7 days' THEN 'critical' ELSE 'warning' END`,
      title: "'Certificado SSL próximo a vencer'",
      detail: "'El certificado de ' || c.domain || ' vence el ' || c.expires_at::date",
      from: "certificates c",
      where: "c.expires_at IS NOT NULL AND c.expires_at <= now() + interval '30 days'",
      application: "c.application_id"
    });
    await upsertApplicationAlerts(transaction, {
      kind: "ssl_renewal_failed",
      severity: "'critical'",
      title: "'La renovación SSL está fallando'",
      detail: "COALESCE(c.error, c.last_renewal_result, 'Certbot no confirmó la renovación')",
      from: "certificates c",
      where: "c.error IS NOT NULL OR c.last_renewal_result = 'failed'",
      application: "c.application_id"
    });
    await upsertApplicationAlerts(transaction, {
      kind: "health_failed",
      severity: "'critical'",
      title: "'Health check fallido'",
      detail: "COALESCE(h.last_error, 'La aplicación no respondió como se esperaba')",
      from: "health_checks h",
      where: "h.last_status = 'unhealthy'",
      application: "h.application_id"
    });
    await upsertApplicationAlerts(transaction, {
      kind: "env_changed",
      severity: "'warning'",
      title: "'.env modificado fuera de JuanOS'",
      detail: "'Revisa y valida de nuevo ' || ef.path",
      from: "environment_files ef JOIN environments e ON e.id = ef.environment_id",
      where: "ef.status = 'changed'",
      application: "e.application_id"
    });
    await upsertApplicationAlerts(transaction, {
      kind: "update_available",
      severity: "'info'",
      title: "'Actualización disponible'",
      detail: "'El commit remoto es distinto del artefacto desplegado'",
      from: "repositories r",
      where: "r.last_remote_commit_sha IS NOT NULL AND r.last_remote_commit_sha IS DISTINCT FROM r.deployed_commit_sha",
      application: "r.application_id"
    });
    await upsertApplicationAlerts(transaction, {
      kind: "deployment_partial",
      severity: "'critical'",
      title: "'Despliegue parcial'",
      detail: "COALESCE(d.error_message, 'Producción fue modificada antes del fallo')",
      from: `LATERAL (
        SELECT DISTINCT ON (project_id) project_id, status, error_message
        FROM deployments ORDER BY project_id, started_at DESC
      ) d`,
      where: "d.status = 'partial'",
      application: "d.project_id"
    });
    await transaction.query(
      `INSERT INTO alerts (application_id, kind, severity, title, detail)
       SELECT NULL, 'disk_low', so.status, 'Espacio en disco bajo',
       'Uso de disco: ' || (so.value->>'usedPercent') || '%'
       FROM system_observations so WHERE so.kind = 'disk'
         AND so.status IN ('warning', 'critical')
       ORDER BY so.observed_at DESC LIMIT 1
       ON CONFLICT (application_id, kind) DO UPDATE SET
        severity = EXCLUDED.severity, title = EXCLUDED.title, detail = EXCLUDED.detail,
        status = 'open', last_seen_at = now(), resolved_at = NULL`
    );
    await transaction.query(
      `INSERT INTO alerts (application_id, kind, severity, title, detail)
       SELECT NULL, 'recovery_failed', 'critical', 'Recovery fallido',
       COALESCE(rs.error, rs.verification_error, 'Snapshot no verificado')
       FROM recovery_snapshots rs
       WHERE rs.status = 'failed' OR rs.verification_status = 'invalid'
       ORDER BY rs.created_at DESC LIMIT 1
       ON CONFLICT (application_id, kind) DO UPDATE SET
        severity = EXCLUDED.severity, title = EXCLUDED.title, detail = EXCLUDED.detail,
        status = 'open', last_seen_at = now(), resolved_at = NULL`
    );
    await resolveAbsentAlerts(transaction);
  });
}

async function upsertApplicationAlerts(db, definition) {
  await db.query(
    `INSERT INTO alerts (application_id, kind, severity, title, detail)
     SELECT ${definition.application}, $1, ${definition.severity}, ${definition.title}, ${definition.detail}
     FROM ${definition.from} WHERE ${definition.where}
     ON CONFLICT (application_id, kind) DO UPDATE SET
      severity = EXCLUDED.severity, title = EXCLUDED.title, detail = EXCLUDED.detail,
      status = 'open', last_seen_at = now(), resolved_at = NULL`,
    [definition.kind]
  );
}

async function resolveAbsentAlerts(db) {
  await db.query(
    `UPDATE alerts a SET status = 'resolved', resolved_at = now()
     WHERE a.status <> 'resolved' AND (
       (a.kind = 'ssl_expiring' AND NOT EXISTS (
         SELECT 1 FROM certificates c WHERE c.application_id = a.application_id
          AND c.expires_at <= now() + interval '30 days'
       ))
       OR (a.kind = 'app_offline' AND NOT EXISTS (
         SELECT 1 FROM projects p WHERE p.id = a.application_id AND p.process_status = 'offline'
       ))
       OR (a.kind = 'ssl_renewal_failed' AND NOT EXISTS (
         SELECT 1 FROM certificates c WHERE c.application_id = a.application_id
          AND (c.error IS NOT NULL OR c.last_renewal_result = 'failed')
       ))
       OR (a.kind = 'health_failed' AND NOT EXISTS (
         SELECT 1 FROM health_checks h WHERE h.application_id = a.application_id
          AND h.last_status = 'unhealthy'
       ))
       OR (a.kind = 'env_changed' AND NOT EXISTS (
         SELECT 1 FROM environment_files ef JOIN environments e ON e.id = ef.environment_id
          WHERE e.application_id = a.application_id AND ef.status = 'changed'
       ))
       OR (a.kind = 'update_available' AND NOT EXISTS (
         SELECT 1 FROM repositories r WHERE r.application_id = a.application_id
          AND r.last_remote_commit_sha IS NOT NULL
          AND r.last_remote_commit_sha IS DISTINCT FROM r.deployed_commit_sha
       ))
       OR (a.kind = 'deployment_partial' AND NOT EXISTS (
         SELECT 1 FROM deployments d WHERE d.project_id = a.application_id AND d.status = 'partial'
          AND NOT EXISTS (SELECT 1 FROM deployments newer WHERE newer.project_id = d.project_id AND newer.started_at > d.started_at)
       ))
       OR (a.kind = 'disk_low' AND NOT EXISTS (
         SELECT 1 FROM system_observations so WHERE so.kind = 'disk'
          AND so.status IN ('warning','critical')
          AND so.observed_at = (SELECT max(observed_at) FROM system_observations WHERE kind = 'disk')
       ))
       OR (a.kind = 'recovery_failed' AND NOT EXISTS (
         SELECT 1 FROM recovery_snapshots rs
          WHERE rs.status = 'failed' OR rs.verification_status = 'invalid'
       ))
     )`
  );
}

export async function runMaintenanceOnce({ db, config }) {
  const results = await Promise.allSettled([
    observeDisk(db, config.PROJECTS_ROOT),
    inspectCertificates(db, config),
    inspectApplications(db, config)
  ]);
  await reconcileAlerts(db);
  return results;
}

export function startMaintenanceWorker({ db, config }) {
  let stopped = false;
  let timer;
  const tick = async () => {
    if (stopped) return;
    await runMaintenanceOnce({ db, config }).catch(() => {});
    timer = setTimeout(tick, 5 * 60_000);
    timer.unref();
  };
  tick();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
