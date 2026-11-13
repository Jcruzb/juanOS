import fs from "node:fs/promises";
import path from "node:path";
import dns from "node:dns/promises";
import { spawn } from "node:child_process";
import { deploymentPlanHash, assertSafeDeploymentPlan } from "./deployment-plan.js";
import { validateDeploymentContext } from "./deployment-context.js";
import { runGit } from "./git.js";
import { redactSecrets } from "./security.js";
import { validatePrivilegedHelper } from "./deploy-script.js";
import { runHostAction } from "./host-operations.js";
import { parseCertbotDryRun } from "./certificates.js";

const MAX_STREAM_BYTES = 1_000_000;
const MAX_SUMMARY_BYTES = 20_000;
const HEARTBEAT_MS = 15_000;
const LOCK_SECONDS = 90;

export const deploymentStreams = new Map();

async function ensureLogFile(config, deploymentId) {
  await fs.mkdir(config.DEPLOY_LOGS_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(config.DEPLOY_LOGS_DIR, 0o700);
  const logPath = path.join(config.DEPLOY_LOGS_DIR, `${deploymentId}.log`);
  const handle = await fs.open(logPath, "a", 0o600);
  await handle.chmod(0o600);
  return { logPath, handle };
}

function createPublisher(stream, handle) {
  let writeQueue = Promise.resolve();
  const publish = (chunk) => {
    const clean = redactSecrets(String(chunk));
    stream.output = (stream.output + clean).slice(-MAX_STREAM_BYTES);
    for (const send of stream.listeners) send(clean);
    writeQueue = writeQueue.then(() => handle.appendFile(clean, "utf8"));
    return writeQueue;
  };
  publish.flush = () => writeQueue;
  return publish;
}

async function claimDeployment(db, workerId) {
  return db.transaction(async (transaction) => {
    await transaction.query("DELETE FROM deployment_locks WHERE expires_at < now()");
    const project = await transaction.query(`SELECT p.id FROM projects p
      WHERE EXISTS (SELECT 1 FROM deployments d WHERE d.project_id = p.id AND d.status = 'queued')
      AND NOT EXISTS (SELECT 1 FROM deployment_locks l WHERE l.application_id = p.id AND l.expires_at >= now())
      ORDER BY p.id FOR UPDATE OF p SKIP LOCKED LIMIT 1`);
    if (!project.rows[0]) return null;
    const selected = await transaction.query(
      `SELECT d.id, d.project_id AS "applicationId", d.plan, d.plan_hash AS "planHash", d.operation,
        p.slug, p.local_path AS "localPath", p.service_name AS "serviceName",
        p.deployment_type AS "legacyDeploymentType", p.is_juanos AS "isJuanOS"
       FROM deployments d JOIN projects p ON p.id = d.project_id
       WHERE d.status = 'queued' AND d.project_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM deployment_locks l
           WHERE l.application_id = d.project_id AND l.expires_at >= now()
         )
       ORDER BY d.started_at
       FOR UPDATE OF d SKIP LOCKED LIMIT 1`, [project.rows[0].id]
    );
    const deployment = selected.rows[0];
    if (!deployment) return null;
    await transaction.query(
      `INSERT INTO deployment_locks
        (application_id, deployment_id, owner, expires_at)
       VALUES ($1,$2,$3,now() + ($4 * interval '1 second'))`,
      [deployment.applicationId, deployment.id, workerId, LOCK_SECONDS]
    );
    await transaction.query(
      `UPDATE deployments SET status = 'running', claimed_by = $2,
       heartbeat_at = now(), log_path = COALESCE(log_path, $3)
       WHERE id = $1`,
      [deployment.id, workerId, `${deployment.id}.log`]
    );
    return deployment;
  });
}

async function recoverInterruptedDeployments(db) {
  await db.query(
    `UPDATE deployments SET
       status = CASE WHEN modifications_started THEN 'partial' ELSE 'queued' END,
       error_code = CASE WHEN modifications_started THEN 'WORKER_INTERRUPTED' ELSE error_code END,
       error_message = CASE WHEN modifications_started
         THEN 'El worker se interrumpió después de modificar producción; requiere revisión.'
         ELSE error_message END,
       claimed_by = NULL
     WHERE status = 'running'
       AND (heartbeat_at IS NULL OR heartbeat_at < now() - interval '2 minutes')`
  );
  await db.query("DELETE FROM deployment_locks WHERE expires_at < now()");
}

async function updateHeartbeat(db, deployment, workerId) {
  await db.query(
    "UPDATE deployments SET heartbeat_at = now() WHERE id = $1 AND claimed_by = $2",
    [deployment.id, workerId]
  );
  await db.query(
    `UPDATE deployment_locks SET heartbeat_at = now(),
     expires_at = now() + ($3 * interval '1 second')
     WHERE deployment_id = $1 AND owner = $2`,
    [deployment.id, workerId, LOCK_SECONDS]
  );
}

async function executeCommand(executable, args, options, publish) {
  const child = spawn(executable, args, { ...options, shell: false });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-1_000_000);
    publish(chunk).catch(() => {});
  });
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-1_000_000);
    publish(chunk).catch(() => {});
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve({ exitCode, stdout, stderr });
      else reject(Object.assign(new Error(`${executable} terminó con código ${exitCode}`), { exitCode }));
    });
  });
}

export async function executePlanStep({ db, config, deployment, step, publish }) {
  const cwd = deployment.localPath;
  const readOnlyActions = new Set([
    "preflight_system", "port_check", "git_status", "git_fetch", "git_compare",
    "health_check", "certbot_dry_run", "recovery_snapshot", "dns_validate",
    "http_port_validate", "recovery_verify"
  ]);
  if (!readOnlyActions.has(step.action)) {
    await db.query("UPDATE deployments SET modifications_started = true WHERE id = $1", [deployment.id]);
  }
  const run = (executable, args, options = {}) => executeCommand(
    executable,
    args,
    { cwd: options.cwd || cwd, ...options },
    publish
  );
  if (step.action === "preflight_system") {
    await runHostAction({
      config,
      deployment,
      action: "preflight",
      parameters: { strategy: step.input.strategy },
      run
    });
    return;
  }
  if (step.action === "port_check") {
    try {
      await runHostAction({
        config,
        deployment,
        action: "port-check",
        parameters: { port: step.input.port },
        run
      });
      await db.query(
        `INSERT INTO port_reservations (application_id, port, protocol, status, last_checked_at)
         VALUES ($1,$2,'tcp','expected',now())
         ON CONFLICT (port, protocol) WHERE status <> 'released'
         DO UPDATE SET application_id = EXCLUDED.application_id,
          status = 'expected', observed_process = NULL, last_checked_at = now()`,
        [deployment.applicationId, step.input.port]
      );
    } catch (error) {
      await db.query(
        `INSERT INTO operational_events
          (application_id, deployment_id, source, level, event_type, metadata)
         VALUES ($1,$2,'port','error','port_collision',$3::jsonb)`,
        [
          deployment.applicationId, deployment.id,
          JSON.stringify({ port: step.input.port })
        ]
      );
      throw Object.assign(error, { code: "PORT_COLLISION" });
    }
    return;
  }
  if (step.action === "dns_validate") {
    const addresses = await dns.resolve4(step.input.domain);
    if (!addresses.length) {
      throw Object.assign(new Error("El dominio no tiene registros A"), { code: "DNS_UNRESOLVED" });
    }
    if (config.VPS_PUBLIC_IP && !addresses.includes(config.VPS_PUBLIC_IP)) {
      await db.query(
        `UPDATE application_domains SET observed_ips = $2::inet[], dns_status = 'mismatch',
         last_checked_at = now(), updated_at = now()
         WHERE application_id = $1 AND hostname = $3`,
        [deployment.applicationId, addresses, step.input.domain]
      );
      throw Object.assign(new Error("El DNS no apunta a la IP pública configurada de la VPS"), {
        code: "DNS_IP_MISMATCH"
      });
    }
    await db.query(
      `UPDATE application_domains SET observed_ips = $2::inet[], dns_status = 'valid',
       last_checked_at = now(), updated_at = now()
       WHERE application_id = $1 AND hostname = $3`,
      [deployment.applicationId, addresses, step.input.domain]
    );
    await publish(`DNS correcto: ${step.input.domain} → ${addresses.join(", ")}\n`);
    return;
  }
  if (step.action === "http_port_validate") {
    await runHostAction({
      config,
      deployment,
      action: "port-listening",
      parameters: { port: step.input.port },
      run
    });
    return;
  }
  if (step.action === "git_clone") {
    await fs.mkdir(path.dirname(cwd), { recursive: true });
    await executeCommand("git", [
      "clone", "--branch", step.input.branch, "--single-branch",
      step.input.repositoryUrl, cwd
    ], { cwd: path.dirname(cwd), shell: false }, publish);
    const actual = (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    if (actual !== deployment.plan.targetCommitSha) throw Object.assign(new Error("La rama remota cambió durante el clonado. Genera otro plan."), { code: "STALE_DEPLOYMENT_PLAN" });
    deployment.codeUpdated = true;
    return;
  }
  if (step.action === "git_status") {
    const result = await runGit(cwd, ["status", "--porcelain=v1"]);
    if (result.stdout.trim()) {
      throw Object.assign(new Error("El repositorio contiene cambios locales"), {
        code: "LOCAL_CHANGES",
        detail: result.stdout.split("\n").filter(Boolean).slice(0, 100)
      });
    }
    await publish("Repositorio sin cambios locales.\n");
    return;
  }
  if (step.action === "git_fetch") {
    const result = await runGit(cwd, ["fetch", "--no-tags", "origin", `refs/heads/${step.input.branch}`]);
    const fetched = (await runGit(cwd, ["rev-parse", "FETCH_HEAD^{commit}"])).stdout.trim();
    if (fetched !== deployment.plan.targetCommitSha) throw Object.assign(new Error("La rama remota cambió; genera otro plan."), { code: "STALE_DEPLOYMENT_PLAN" });
    await publish(result.stdout || "Referencias remotas actualizadas.\n");
    return;
  }
  if (step.action === "git_compare") {
    const result = await runGit(cwd, ["rev-list", "--count", `HEAD..${deployment.plan.targetCommitSha}`]);
    await publish(`Commits remotos pendientes: ${result.stdout.trim() || "0"}\n`);
    return;
  }
  if (step.action === "git_fast_forward") {
    await validateDeploymentContext(db, deployment.plan);
    const result = await runGit(cwd, ["merge", "--ff-only", deployment.plan.targetCommitSha]);
    deployment.codeUpdated = true;
    await publish(result.stdout || "Copia de trabajo actualizada.\n");
    return;
  }
  if (step.action === "package_install") {
    const workingDirectory = await resolveWorkingDirectory(cwd, step.input.workingDirectory);
    const manager = await detectPackageManager(workingDirectory, step.input.packageManager);
    const command = packageInstallCommand(manager);
    await executeCommand(command.executable, command.args, { cwd: workingDirectory }, publish);
    return;
  }
  if (step.action === "package_build") {
    const workingDirectory = await resolveWorkingDirectory(cwd, step.input.workingDirectory);
    const manager = await detectPackageManager(workingDirectory, step.input.packageManager);
    const command = packageScriptCommand(manager, step.input.scriptName);
    await executeCommand(command.executable, command.args, { cwd: workingDirectory }, publish);
    return;
  }
  if (step.action === "python_install") {
    const workingDirectory = await resolveWorkingDirectory(cwd, step.input.workingDirectory);
    const pip = await resolveProjectExecutable(workingDirectory, step.input.venv, "pip");
    const requirements = await resolveProjectFile(workingDirectory, step.input.requirements);
    await executeCommand(pip, ["install", "-r", requirements], { cwd: workingDirectory }, publish);
    return;
  }
  if (step.action === "django_migrate" || step.action === "django_collectstatic") {
    if (step.action === "django_migrate") {
      const backup = await db.query("SELECT id FROM database_backups WHERE deployment_id = $1 AND application_id = $2 AND status = 'verified' AND path IS NOT NULL AND checksum IS NOT NULL AND size > 0", [deployment.id, deployment.applicationId]);
      if (!backup.rows.length) throw Object.assign(new Error("No existe un backup verificado para esta migración."), { code: "DATABASE_BACKUP_REQUIRED" });
    }
    const workingDirectory = await resolveWorkingDirectory(cwd, step.input.workingDirectory);
    const python = await resolveProjectExecutable(workingDirectory, step.input.venv, "python");
    const args = step.action === "django_migrate"
      ? ["manage.py", "migrate", "--noinput"]
      : ["manage.py", "collectstatic", "--noinput"];
    await executeCommand(python, args, { cwd: workingDirectory }, publish);
    return;
  }
  if (step.action === "pm2_reload") {
    const ecosystem = step.input.ecosystemFile || "ecosystem.config.cjs";
    const ecosystemPath = await resolveProjectFile(cwd, ecosystem);
    await executeCommand("pm2", ["startOrReload", ecosystemPath, "--update-env"], { cwd }, publish);
    await executeCommand("pm2", ["save"], { cwd }, publish);
    return;
  }
  if (step.action === "database_backup") {
    const backup = await db.query(
      `INSERT INTO database_backups
        (application_id, deployment_id, strategy, status)
       VALUES ($1,$2,$3,'running') RETURNING id`,
      [deployment.applicationId, deployment.id, step.input.strategy]
    );
    try {
      const result = await runHostAction({
        config,
        deployment,
        action: "database-backup",
        parameters: {
          strategy: step.input.strategy,
          deployment: deployment.id
        },
        run
      });
      const metadata = parseLastJsonLine(result.stdout);
      if (!metadata?.path || !/^[a-f0-9]{64}$/i.test(metadata.checksum || "") || !(Number(metadata.size) > 0)) throw Object.assign(new Error("El backup no devolvió evidencia verificable."), { code: "DATABASE_BACKUP_UNVERIFIED" });
      await db.query(
        `UPDATE database_backups SET status = 'verified', path = $2, checksum = $3,
         size = $4, verified_at = now() WHERE id = $1`,
        [backup.rows[0].id, metadata.path, metadata.checksum, metadata.size]
      );
    } catch (error) {
      await db.query(
        "UPDATE database_backups SET status = 'failed', error = $2 WHERE id = $1",
        [backup.rows[0].id, redactSecrets(error.message).slice(0, 1000)]
      );
      throw error;
    }
    return;
  }
  if (step.action === "static_publish") {
    const workingDirectory = await resolveWorkingDirectory(cwd, step.input.workingDirectory);
    const source = path.relative(cwd, await resolveProjectDirectory(
      workingDirectory,
      step.input.outputDirectory
    ));
    const commit = (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    await runHostAction({
      config,
      deployment,
      action: "publish-static",
      parameters: {
        source,
        commit,
        deployment: deployment.id
      },
      run
    });
    return;
  }
  if (step.action === "systemd_restart") {
    await runHostAction({
      config,
      deployment,
      action: "systemd-restart",
      parameters: { service: step.input.serviceName },
      run
    });
    return;
  }
  if (step.action.startsWith("docker_compose_")) {
    const actionMap = {
      docker_compose_pull: "compose-pull",
      docker_compose_build: "compose-build",
      docker_compose_up: "compose-up",
      docker_compose_restart: "compose-restart"
    };
    const commit = await currentCommit(cwd);
    await runHostAction({
      config,
      deployment,
      action: actionMap[step.action],
      parameters: {
        "compose-file": step.input.composeFile,
        commit,
        deployment: deployment.id
      },
      run
    });
    return;
  }
  if (step.action === "docker_build" || step.action === "docker_recreate") {
    const commit = await currentCommit(cwd);
    await runHostAction({
      config,
      deployment,
      action: step.action === "docker_build" ? "docker-build" : "docker-recreate",
      parameters: {
        dockerfile: step.input.dockerfile,
        image: step.input.imageName,
        container: step.input.containerName,
        port: step.input.port,
        commit,
        deployment: deployment.id
      },
      run
    });
    return;
  }
  if (step.action === "nginx_configure") {
    await runHostAction({ config, deployment, action: "nginx-configure", run });
    return;
  }
  if (step.action === "nginx_validate_reload") {
    await runHostAction({ config, deployment, action: "nginx-test-reload", run });
    return;
  }
  if (step.action === "certbot_issue" || step.action === "certbot_dry_run") {
    const result = await runHostAction({
      config,
      deployment,
      action: step.action === "certbot_issue" ? "certbot-issue" : "certbot-dry-run",
      parameters: {
        domain: step.input.domain,
        "include-www": step.input.includeWww
      },
      run
    });
    if (step.action === "certbot_dry_run") {
      const parsed = parseCertbotDryRun(`${result?.stdout || ""}\n${result?.stderr || ""}`, result?.exitCode || 0);
      await db.query(
        `UPDATE certificates SET last_renewal_check = now(),
         last_renewal_result = $2, error = $3, updated_at = now()
         WHERE application_id = $1 AND domain = $4`,
        [
          deployment.applicationId,
          parsed.success ? "succeeded" : "failed",
          parsed.success ? null : parsed.summary,
          step.input.domain
        ]
      );
      if (!parsed.success) {
        throw Object.assign(new Error(parsed.summary), { code: "CERTBOT_DRY_RUN_FAILED" });
      }
    }
    return;
  }
  if (step.action === "deployed_marker") {
    const commit = await currentCommit(cwd);
    await db.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE repositories SET deployed_commit_sha = $2, current_branch = $3,
         updated_at = now() WHERE application_id = $1`,
        [deployment.applicationId, commit, deployment.plan.targetBranch]
      );
      await transaction.query(
        "UPDATE deployments SET target_commit_sha = $2 WHERE id = $1",
        [deployment.id, commit]
      );
      await transaction.query(
        `INSERT INTO deployment_artifacts
          (deployment_id, application_id, kind, reference, commit_sha, metadata)
         VALUES ($1,$2,'marker',$3,$4,$5::jsonb)`,
        [
          deployment.id,
          deployment.applicationId,
          `${deployment.slug}:${deployment.id}`,
          commit,
          JSON.stringify({ strategy: step.input.strategy })
        ]
      );
    });
    await publish(`Commit desplegado registrado: ${commit}\n`);
    return;
  }
  if (step.action === "rollback_release") {
    await runHostAction({
      config,
      deployment,
      action: "rollback-release",
      parameters: { deployment: deployment.id },
      run
    });
    return;
  }
  if (step.action === "health_check") {
    const started = Date.now();
    try {
      const health = await executeHealthCheck(step.input, publish);
      await persistHealthObservation(db, deployment, step.input, health, Date.now() - started);
    } catch (error) {
      await persistHealthObservation(db, deployment, step.input, {
        status: "unhealthy",
        httpStatus: error.httpStatus || null,
        detail: error.message
      }, Date.now() - started);
      throw error;
    }
    return;
  }

  if (step.action === "recovery_snapshot") {
    const helper = await validatePrivilegedHelper(
      config.JUANOS_RECOVERY_HELPER,
      config.NODE_ENV === "production"
    );
    const created = await db.query(
      `INSERT INTO recovery_snapshots
        (status, deployment_id, juanos_version, encryption)
       VALUES ('creating',$1,$2,'age') RETURNING id`,
      [deployment.id, config.JUANOS_VERSION || "unknown"]
    );
    const snapshotId = created.rows[0].id;
    try {
      const useSudo = config.JUANOS_HOST_HELPER_USE_SUDO !== "0";
      const result = await executeCommand(
        useSudo ? "sudo" : helper,
        useSudo
          ? ["-n", helper, "create", "--snapshot", snapshotId]
          : ["create", "--snapshot", snapshotId],
        { env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } },
        publish
      );
      const metadata = parseLastJsonLine(result.stdout);
      if (!metadata?.path || !/^[a-f0-9]{64}$/i.test(metadata.checksum || "") || !(Number(metadata.size) > 0)) throw Object.assign(new Error("El backup no devolvió evidencia verificable."), { code: "DATABASE_BACKUP_UNVERIFIED" });
      await db.query(
        `UPDATE recovery_snapshots SET status = 'available', remote_provider = $2,
         remote_path = $3, local_path = $4, checksum = $5, size = $6,
         encryption = $7, manifest = $8::jsonb, error = NULL WHERE id = $1`,
        [
          snapshotId, metadata.remoteProvider, metadata.remotePath, metadata.localPath,
          metadata.checksum, metadata.size, metadata.encryption,
          JSON.stringify(metadata.manifest || {})
        ]
      );
    } catch (error) {
      await db.query(
        "UPDATE recovery_snapshots SET status = 'failed', error = $2 WHERE id = $1",
        [snapshotId, redactSecrets(error.message).slice(0, 1000)]
      );
      throw error;
    }
    return;
  }
  if (step.action === "recovery_verify") {
    const helper = await validatePrivilegedHelper(
      config.JUANOS_RECOVERY_HELPER,
      config.NODE_ENV === "production"
    );
    await db.query(
      `UPDATE recovery_snapshots SET verification_status = 'running',
       verification_error = NULL WHERE id = $1`,
      [step.input.snapshotId]
    );
    try {
      const useSudo = config.JUANOS_HOST_HELPER_USE_SUDO !== "0";
      const args = [
        "verify", "--remote-file", step.input.remotePath, "--checksum", step.input.checksum
      ];
      const result = await executeCommand(
        useSudo ? "sudo" : helper,
        useSudo ? ["-n", helper, ...args] : args,
        { env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } },
        publish
      );
      const metadata = parseLastJsonLine(result.stdout);
      if (!metadata?.path || !/^[a-f0-9]{64}$/i.test(metadata.checksum || "") || !(Number(metadata.size) > 0)) throw Object.assign(new Error("El backup no devolvió evidencia verificable."), { code: "DATABASE_BACKUP_UNVERIFIED" });
      await db.query(
        `UPDATE recovery_snapshots SET status = 'verified', verification_status = 'valid',
         verified_at = $2, verification_error = NULL, manifest = $3::jsonb WHERE id = $1`,
        [step.input.snapshotId, metadata.verifiedAt, JSON.stringify(metadata.manifest || {})]
      );
    } catch (error) {
      await db.query(
        `UPDATE recovery_snapshots SET verification_status = 'invalid',
         verification_error = $2 WHERE id = $1`,
        [step.input.snapshotId, redactSecrets(error.message).slice(0, 1000)]
      );
      throw error;
    }
    return;
  }
  if (step.action === "self_update") {
    const helper = await validatePrivilegedHelper(
      config.JUANOS_SELF_UPDATE_HELPER,
      config.NODE_ENV === "production"
    );
    const useSudo = config.JUANOS_HOST_HELPER_USE_SUDO !== "0";
    await executeCommand(
      useSudo ? "sudo" : helper,
      useSudo
        ? ["-n", helper, "update", "--deployment", deployment.id]
        : ["update", "--deployment", deployment.id],
      {
        cwd,
        env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }
      },
      publish
    );
    return;
  }
  throw Object.assign(new Error(`Acción no implementada: ${step.action}`), { code: "ACTION_NOT_IMPLEMENTED" });
}

async function executeHealthCheck(input, publish) {
  const url = new URL(input.url);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Protocolo de health check no permitido");
  const retries = Math.min(Math.max(input.retries ?? 3, 0), 10);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs || 5000);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
      const body = input.responseMatch ? await response.text() : "";
      if (response.status !== (input.expectedStatus || 200)) throw new Error(`HTTP ${response.status}`);
      if (input.responseMatch && !body.includes(input.responseMatch)) throw new Error("La respuesta no contiene el texto esperado");
      await publish(`Health check correcto: HTTP ${response.status}\n`);
      return { status: "healthy", httpStatus: response.status, detail: "HTTP correcto" };
    } catch (error) {
      lastError = error;
      await publish(`Health check intento ${attempt + 1} falló: ${error.message}\n`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw Object.assign(lastError || new Error("Health check fallido"), { code: "HEALTH_CHECK_FAILED" });
}

async function resolveWorkingDirectory(projectRoot, relativePath = ".") {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw Object.assign(new Error("Directorio de trabajo no válido"), { code: "INVALID_WORKING_DIRECTORY" });
  }
  const root = await fs.realpath(projectRoot);
  const target = await fs.realpath(path.resolve(root, relativePath));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw Object.assign(new Error("El directorio sale de la aplicación"), { code: "WORKING_DIRECTORY_ESCAPE" });
  }
  return target;
}

async function resolveProjectFile(root, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw Object.assign(new Error("Ruta de archivo no válida"), { code: "INVALID_PROJECT_FILE" });
  }
  const target = await fs.realpath(path.resolve(root, relativePath));
  const rootReal = await fs.realpath(root);
  if (!target.startsWith(`${rootReal}${path.sep}`)) throw new Error("Archivo fuera de la aplicación");
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error("La ruta esperada no es un archivo");
  return target;
}

async function resolveProjectDirectory(root, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw Object.assign(new Error("Ruta de directorio no válida"), { code: "INVALID_PROJECT_DIRECTORY" });
  }
  const target = await fs.realpath(path.resolve(root, relativePath));
  const rootReal = await fs.realpath(root);
  if (!target.startsWith(`${rootReal}${path.sep}`)) throw new Error("Directorio fuera de la aplicación");
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error("La ruta esperada no es un directorio");
  return target;
}

async function resolveProjectExecutable(workingDirectory, venv, name) {
  const venvDirectory = await resolveProjectDirectory(workingDirectory, venv);
  const executable = await resolveProjectFile(venvDirectory, `bin/${name}`);
  const stat = await fs.stat(executable);
  if ((stat.mode & 0o111) === 0) throw new Error(`El ejecutable ${name} no tiene permisos de ejecución`);
  return executable;
}

async function detectPackageManager(workingDirectory, configured) {
  if (configured && ["npm", "yarn", "pnpm"].includes(configured)) return configured;
  if (await fs.stat(path.join(workingDirectory, "pnpm-lock.yaml")).then(() => true, () => false)) return "pnpm";
  if (await fs.stat(path.join(workingDirectory, "yarn.lock")).then(() => true, () => false)) return "yarn";
  if (await fs.stat(path.join(workingDirectory, "package-lock.json")).then(() => true, () => false)) return "npm";
  throw Object.assign(new Error("No existe lockfile; no se instalarán dependencias de producción"), {
    code: "LOCKFILE_REQUIRED"
  });
}

function packageInstallCommand(manager) {
  if (manager === "pnpm") return { executable: "pnpm", args: ["install", "--frozen-lockfile"] };
  if (manager === "yarn") return { executable: "yarn", args: ["install", "--frozen-lockfile"] };
  return { executable: "npm", args: ["ci"] };
}

function packageScriptCommand(manager, scriptName) {
  if (!/^[A-Za-z0-9:_-]+$/.test(scriptName)) throw new Error("Script package no válido");
  if (manager === "pnpm") return { executable: "pnpm", args: ["run", scriptName] };
  if (manager === "yarn") return { executable: "yarn", args: [scriptName] };
  return { executable: "npm", args: ["run", scriptName] };
}

async function currentCommit(cwd) {
  return (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

function parseLastJsonLine(output) {
  const lines = String(output).split("\n").map((line) => line.trim()).filter(Boolean);
  try {
    return JSON.parse(lines.at(-1) || "");
  } catch {
    throw Object.assign(new Error("El helper no devolvió metadata JSON válida"), {
      code: "INVALID_HELPER_RESPONSE"
    });
  }
}

async function persistHealthObservation(db, deployment, input, result, durationMs) {
  if (!input.id) return;
  await db.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO health_observations
        (health_check_id, deployment_id, status, http_status, duration_ms, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.id, deployment.id, result.status, result.httpStatus, durationMs, result.detail]
    );
    await transaction.query(
      `UPDATE health_checks SET last_status = $2, last_checked_at = now(),
       last_error = $3, updated_at = now() WHERE id = $1`,
      [input.id, result.status, result.status === "healthy" ? null : result.detail]
    );
    await transaction.query(
      `UPDATE projects SET http_health_status = $2,
       status = CASE WHEN $2 = 'healthy' THEN 'online' ELSE 'degraded' END,
       updated_at = now() WHERE id = $1`,
      [deployment.applicationId, result.status]
    );
  });
}

export async function runDeploymentWorkerOnce({ db, config, workerId }) {
  const deployment = await claimDeployment(db, workerId);
  if (!deployment) return false;

  let logResource;
  try {
    logResource = await ensureLogFile(config, deployment.id);
  } catch (error) {
    await db.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE deployments SET status = 'failed', finished_at = now(),
         error_code = 'LOG_INITIALIZATION_FAILED', error_message = $2 WHERE id = $1`,
        [deployment.id, redactSecrets(error.message).slice(0, 1000)]
      );
      await transaction.query("DELETE FROM deployment_locks WHERE deployment_id = $1", [deployment.id]);
    });
    return true;
  }
  const { logPath, handle } = logResource;
  const stream = { listeners: new Set(), output: "", done: false };
  deploymentStreams.set(deployment.id, stream);
  const publish = createPublisher(stream, handle);
  const heartbeat = setInterval(() => {
    updateHeartbeat(db, deployment, workerId).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref();
  let finalStatus = "succeeded";
  let finalError = null;
  try {
    await db.query("UPDATE deployments SET log_path = $2 WHERE id = $1", [deployment.id, logPath]);
    assertSafeDeploymentPlan(deployment.plan);
    if (deploymentPlanHash(deployment.plan) !== deployment.planHash) throw Object.assign(new Error("El plan almacenado cambió; genera otro plan."), { code: "STALE_DEPLOYMENT_PLAN" });
    await validateDeploymentContext(db, deployment.plan, { refreshTarget: ["deploy", "update", "repair"].includes(deployment.operation) });
    for (let position = 0; position < deployment.plan.steps.length; position += 1) {
      const planStep = deployment.plan.steps[position];
      await db.query(
        `UPDATE deployment_steps SET status = 'running', started_at = now()
         WHERE deployment_id = $1 AND step_key = $2`,
        [deployment.id, planStep.stepKey]
      );
      await publish(`\n[${position + 1}/${deployment.plan.steps.length}] ${planStep.name}\n`);
      try {
        await validateDeploymentContext(db, deployment.plan, { codeUpdated: Boolean(deployment.codeUpdated) });
        await executePlanStep({ db, config, deployment, step: planStep, publish });
        await db.query(
          `UPDATE deployment_steps SET status = 'succeeded', finished_at = now(), exit_code = 0
           WHERE deployment_id = $1 AND step_key = $2`,
          [deployment.id, planStep.stepKey]
        );
      } catch (error) {
        finalError = error;
        const modified = await db.query("SELECT modifications_started FROM deployments WHERE id = $1", [deployment.id]);
        finalStatus = modified.rows[0]?.modifications_started ? "partial" : "failed";
        await db.query(
          `UPDATE deployment_steps SET status = 'failed', finished_at = now(),
           exit_code = $3, error_message = $4
           WHERE deployment_id = $1 AND step_key = $2`,
          [deployment.id, planStep.stepKey, error.exitCode ?? null, redactSecrets(error.message).slice(0, 1000)]
        );
        throw error;
      }
    }
  } catch (error) {
    if (!finalError) { finalError = error; finalStatus = "failed"; }
    await publish(`\nError: ${error.message}\n`);
  } finally {
    clearInterval(heartbeat);
    stream.done = true;
    await publish.flush();
    await handle.close();
    await db.transaction(async (transaction) => {
      await transaction.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [deployment.applicationId]);
      await transaction.query(
        `UPDATE deployments SET status = $2, finished_at = now(),
         error_code = $3, error_message = $4, output_summary = $5
         WHERE id = $1`,
        [
          deployment.id,
          finalStatus,
          finalError?.code || null,
          finalError ? redactSecrets(finalError.message).slice(0, 1000) : null,
          stream.output.slice(-MAX_SUMMARY_BYTES)
        ]
      );
      await transaction.query("DELETE FROM deployment_locks WHERE deployment_id = $1", [deployment.id]);
      if (finalStatus === "succeeded") {
        await transaction.query(
          "UPDATE projects SET last_deployed_at = now(), updated_at = now() WHERE id = $1",
          [deployment.applicationId]
        );
      }
    });
    setTimeout(() => deploymentStreams.delete(deployment.id), 10 * 60_000).unref();
  }
  return true;
}

export function startDeploymentWorker({ db, config }) {
  const workerId = `api-${process.pid}`;
  let stopped = false;
  let timer = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const handled = await runDeploymentWorkerOnce({ db, config, workerId });
      timer = setTimeout(tick, handled ? 50 : 1500);
    } catch {
      timer = setTimeout(tick, 3000);
    }
    timer.unref();
  };
  recoverInterruptedDeployments(db).finally(tick);
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export { recoverInterruptedDeployments };
