import { idSchema, projectSchema } from "@juanos/shared";
import { assertProjectPath } from "./security.js";
import { writeAudit } from "./audit.js";
import { requireCsrf } from "./auth.js";
import { runGit } from "./git.js";
import { z } from "zod";

const selectProject = `SELECT p.id, p.name, p.slug, p.local_path AS "localPath",
  p.repository_url AS "repositoryUrl", p.default_branch AS "defaultBranch",
  p.deployment_type AS "deploymentType", p.service_name AS "serviceName",
  p.application_type AS "applicationType", p.status, p.is_juanos AS "isJuanOS",
  p.process_status AS "processStatus", p.http_health_status AS "httpHealthStatus",
  p.functional_health_status AS "functionalHealthStatus",
  p.expected_state AS "expectedState", p.observed_state AS "observedState",
  p.observed_at AS "observedAt", p.last_inspected_at AS "lastInspectedAt",
  p.state_ignore_until AS "stateIgnoreUntil",
  p.last_deployed_at AS "lastDeployedAt", p.is_active AS "isActive",
  p.created_at AS "createdAt", p.updated_at AS "updatedAt",
  ds.strategy, ds.config AS "strategyConfig",
  r.current_branch AS "storedCurrentBranch",
  r.deployed_commit_sha AS "deployedCommitSha",
  r.last_remote_commit_sha AS "lastRemoteCommitSha",
  COALESCE(ad.hostname, c.domain) AS domain,
  c.issuer AS "sslIssuer", c.expires_at AS "sslExpiresAt",
  c.auto_renew_configured AS "sslAutoRenewConfigured",
  (SELECT d.status FROM deployments d WHERE d.project_id = p.id
   ORDER BY d.started_at DESC LIMIT 1) AS "lastDeploymentStatus",
  (SELECT count(*)::int FROM alerts a WHERE a.application_id = p.id AND a.status = 'open') AS "openAlerts"
  FROM projects p
  LEFT JOIN deployment_strategies ds ON ds.application_id = p.id
  LEFT JOIN repositories r ON r.application_id = p.id
  LEFT JOIN LATERAL (
    SELECT * FROM certificates WHERE application_id = p.id ORDER BY expires_at LIMIT 1
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT hostname FROM application_domains WHERE application_id = p.id
    ORDER BY is_primary DESC, created_at LIMIT 1
  ) ad ON true`;

async function enrichProject(project) {
  try {
    const [status, branch, commit, fullCommit, pending] = await Promise.all([
      runGit(project.localPath, ["status", "--porcelain=v1"]),
      runGit(project.localPath, ["branch", "--show-current"]),
      runGit(project.localPath, ["log", "-1", "--pretty=format:%h%x09%s"]),
      runGit(project.localPath, ["rev-parse", "HEAD"]),
      runGit(project.localPath, ["rev-list", "--count", `HEAD..origin/${project.defaultBranch}`])
        .catch(() => ({ stdout: "" }))
    ]);
    const [shortSha = "", message = "Sin commits"] = commit.stdout.split("\t");
    const currentBranch = branch.stdout.trim() || project.defaultBranch;
    const sslDaysRemaining = project.sslExpiresAt
      ? Math.ceil((new Date(project.sslExpiresAt).getTime() - Date.now()) / 86_400_000)
      : null;
    return {
      ...project,
      currentBranch,
      repositoryCommitSha: fullCommit.stdout.trim(),
      repositoryStatus: status.stdout.trim() ? "modified" : "clean",
      changedFiles: status.stdout.split("\n").filter(Boolean).length,
      commit: shortSha,
      message,
      pendingCommits: Number.parseInt(pending.stdout.trim(), 10) || 0,
      sslDaysRemaining,
      expectedState: {
        ...project.expectedState,
        branch: project.expectedState?.branch || project.defaultBranch,
        strategy: project.expectedState?.strategy || project.strategy
      },
      observedState: {
        ...project.observedState,
        branch: currentBranch,
        repositoryCommitSha: fullCommit.stdout.trim(),
        localChanges: Boolean(status.stdout.trim())
      },
      service: project.lastDeploymentStatus === "failed" || project.lastDeploymentStatus === "partial"
        ? "attention"
        : project.status
    };
  } catch {
    return {
      ...project,
      currentBranch: project.storedCurrentBranch || project.defaultBranch,
      repositoryCommitSha: null,
      repositoryStatus: "unavailable",
      changedFiles: 0,
      commit: "",
      message: "Repositorio aún no disponible",
      pendingCommits: null,
      sslDaysRemaining: null,
      service: project.status || "unknown"
    };
  }
}

function strategyForInput(input) {
  if (input.strategy) return input.strategy;
  return input.deploymentType === "docker-compose" ? "docker_compose" : "systemd";
}

function providerFor(repositoryUrl) {
  if (/github\.com/i.test(repositoryUrl)) return "github";
  if (/gitlab\.com/i.test(repositoryUrl)) return "gitlab";
  return "other";
}

export function createProjectsRouter({ express, db, config }) {
  const router = express.Router();

  router.get("/", async (_request, response, next) => {
    try {
      const result = await db.query(`${selectProject} WHERE p.is_active = true ORDER BY p.is_juanos DESC, p.name`);
      response.json({ projects: await Promise.all(result.rows.map(enrichProject)) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:projectId", async (request, response, next) => {
    try {
      const applicationId = idSchema.parse(request.params.projectId);
      const result = await db.query(`${selectProject} WHERE p.id = $1`, [applicationId]);
      if (!result.rows[0]) throw Object.assign(new Error("Aplicación no encontrada"), { status: 404 });
      const [application, services, deployments, alerts] = await Promise.all([
        enrichProject(result.rows[0]),
        db.query(
          `SELECT id, name, service_type AS "serviceType", working_directory AS "workingDirectory",
           status, config, expected_state AS "expectedState", observed_state AS "observedState",
           observed_at AS "observedAt"
           FROM application_services WHERE application_id = $1 ORDER BY name`,
          [applicationId]
        ),
        db.query(
          `SELECT id, operation, status, started_at AS "startedAt", finished_at AS "finishedAt",
           error_code AS "errorCode", error_message AS "errorMessage"
           FROM deployments WHERE project_id = $1 ORDER BY started_at DESC LIMIT 20`,
          [applicationId]
        ),
        db.query(
          `SELECT id, kind, severity, status, title, detail, last_seen_at AS "lastSeenAt"
           FROM alerts WHERE application_id = $1 AND status <> 'resolved'
           ORDER BY severity DESC, last_seen_at DESC`,
          [applicationId]
        )
      ]);
      response.json({
        application,
        services: services.rows,
        deployments: deployments.rows,
        alerts: alerts.rows
      });
    } catch (error) { next(error); }
  });

  router.post("/:projectId/state/accept-observed", requireCsrf, async (request, response, next) => {
    try {
      const applicationId = idSchema.parse(request.params.projectId);
      z.object({ confirm: z.literal(true) }).parse(request.body);
      const result = await db.query(
        `UPDATE projects SET expected_state = observed_state, state_ignore_until = NULL,
         state_decision_note = 'observed_accepted', updated_at = now()
         WHERE id = $1 AND observed_at IS NOT NULL RETURNING expected_state`,
        [applicationId]
      );
      if (!result.rows[0]) throw Object.assign(new Error("No existe estado observado para aceptar"), { status: 409 });
      await writeAudit(db, request, {
        action: "application.observed_state_accepted",
        resourceType: "application",
        resourceId: applicationId,
        metadata: {}
      });
      response.json({ expectedState: result.rows[0].expected_state });
    } catch (error) { next(error); }
  });

  router.post("/:projectId/state/ignore", requireCsrf, async (request, response, next) => {
    try {
      const applicationId = idSchema.parse(request.params.projectId);
      const input = z.object({
        minutes: z.number().int().min(5).max(1440).default(60),
        note: z.string().trim().max(500).optional()
      }).parse(request.body);
      const result = await db.query(
        `UPDATE projects SET state_ignore_until = now() + ($2 * interval '1 minute'),
         state_decision_note = $3, updated_at = now() WHERE id = $1
         RETURNING state_ignore_until`,
        [applicationId, input.minutes, input.note || "ignored_temporarily"]
      );
      if (!result.rows[0]) throw Object.assign(new Error("Aplicación no encontrada"), { status: 404 });
      await writeAudit(db, request, {
        action: "application.observed_state_ignored",
        resourceType: "application",
        resourceId: applicationId,
        metadata: { minutes: input.minutes }
      });
      response.json({ ignoreUntil: result.rows[0].state_ignore_until });
    } catch (error) { next(error); }
  });

  router.post("/", requireCsrf, async (request, response, next) => {
    try {
      const input = projectSchema.parse(request.body);
      const localPath = assertProjectPath(config.PROJECTS_ROOT, input.localPath);
      const strategy = strategyForInput(input);
      const applicationId = await db.transaction(async (transaction) => {
        const result = await transaction.query(
          `INSERT INTO projects
          (name, slug, local_path, repository_url, default_branch, install_command,
           build_command, deploy_command, deployment_type, service_name,
           application_type, is_juanos, expected_state)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING id`,
          [
            input.name, input.slug, localPath, input.repositoryUrl, input.defaultBranch,
            input.installCommand, input.buildCommand, input.deployCommand,
            input.deploymentType, input.serviceName, input.applicationType, input.isJuanOS,
            JSON.stringify({ branch: input.defaultBranch, strategy })
          ]
        );
        const id = result.rows[0].id;
        await transaction.query(
          `INSERT INTO repositories
            (application_id, provider, repository_url, default_branch)
           VALUES ($1,$2,$3,$4)`,
          [id, providerFor(input.repositoryUrl), input.repositoryUrl, input.defaultBranch]
        );
        await transaction.query(
          `INSERT INTO deployment_strategies (application_id, strategy, config)
           VALUES ($1,$2,$3::jsonb)`,
          [id, strategy, JSON.stringify({ serviceName: input.serviceName, ...(input.strategyConfig || {}) })]
        );
        await transaction.query(
          `INSERT INTO host_observability_authorizations (application_id, status)
           VALUES ($1,$2)`,
          [id, input.isJuanOS ? "authorized" : ["systemd", "docker_compose"].includes(strategy) ? "required" : "not_required"]
        );
        await transaction.query(
          `INSERT INTO environments (application_id, name, is_default)
           VALUES ($1,'production',true)`,
          [id]
        );
        await transaction.query(
          `INSERT INTO application_services
            (application_id, name, service_type, working_directory, config)
           VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [id, input.serviceName, strategy, localPath, JSON.stringify({})]
        );
        if (input.domain) {
          await transaction.query(
            `INSERT INTO application_domains (application_id, hostname, is_primary)
             VALUES ($1,$2,true)`,
            [id, input.domain]
          );
        }
        if (input.healthCheck) {
          await transaction.query(
            `INSERT INTO health_checks
              (application_id, url, expected_status, timeout_ms, retries, response_match)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              id, input.healthCheck.url, input.healthCheck.expectedStatus,
              input.healthCheck.timeoutMs, input.healthCheck.retries,
              input.healthCheck.responseMatch || null
            ]
          );
        }
        return id;
      });
      await writeAudit(db, request, {
        action: "project.created",
        resourceType: "application",
        resourceId: applicationId,
        metadata: { name: input.name, localPath, strategy, isJuanOS: input.isJuanOS }
      });
      const created = await db.query(`${selectProject} WHERE p.id = $1`, [applicationId]);
      response.status(201).json({ project: await enrichProject(created.rows[0]) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
