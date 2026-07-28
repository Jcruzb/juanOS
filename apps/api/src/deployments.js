import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { idSchema } from "@juanos/shared";
import { requireCsrf } from "./auth.js";
import { buildDeploymentPlan } from "./deployment-plan.js";
import { runGit } from "./git.js";
import { writeAudit } from "./audit.js";
export { deploymentStreams } from "./deployment-worker.js";
export { validateDeployScript } from "./deploy-script.js";

const operationSchema = z.object({
  applicationId: idSchema,
  operation: z.enum([
    "deploy", "update", "repair", "restart", "ssl_test", "recovery", "recovery_test", "rollback"
  ])
});
const confirmSchema = z.object({ planHash: z.string().length(64) });

async function applicationForPlan(db, id) {
  const result = await db.query(
    `SELECT p.id, p.slug, p.name, p.local_path AS "localPath",
      p.default_branch AS "defaultBranch", p.is_juanos AS "isJuanOS",
      p.application_type AS "applicationType", p.service_name AS "serviceName",
      p.repository_url AS "repositoryUrl",
      ds.strategy, ds.config AS "strategyConfig",
      hc.id AS "healthId", hc.url AS "healthUrl", hc.expected_status AS "healthExpectedStatus",
      hc.timeout_ms AS "healthTimeoutMs", hc.retries AS "healthRetries",
      hc.response_match AS "healthResponseMatch",
      ad.hostname AS domain,
      rs.id AS "recoverySnapshotId", rs.remote_path AS "recoveryRemotePath",
      rs.checksum AS "recoveryChecksum"
     FROM projects p
     JOIN deployment_strategies ds ON ds.application_id = p.id
     LEFT JOIN LATERAL (
       SELECT * FROM health_checks WHERE application_id = p.id ORDER BY created_at LIMIT 1
     ) hc ON true
     LEFT JOIN LATERAL (
       SELECT hostname FROM application_domains WHERE application_id = p.id
       ORDER BY is_primary DESC, created_at LIMIT 1
     ) ad ON true
     LEFT JOIN LATERAL (
       SELECT id, remote_path, checksum FROM recovery_snapshots
       WHERE status IN ('available', 'verified')
       ORDER BY created_at DESC LIMIT 1
     ) rs ON true
     WHERE p.id = $1 AND p.is_active = true`,
    [id]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Aplicación no encontrada o sin estrategia"), { status: 404 });
  const row = result.rows[0];
  const repositoryExists = await fs.stat(path.join(row.localPath, ".git"))
    .then((stat) => stat.isDirectory(), () => false);
  let currentCommit = null;
  if (repositoryExists) {
    const commit = await runGit(row.localPath, ["rev-parse", "HEAD"]);
    const status = await runGit(row.localPath, ["status", "--porcelain=v1"]);
    if (status.stdout.trim()) {
      throw Object.assign(new Error("Hay cambios locales; revísalos antes de crear el plan"), {
        status: 409,
        code: "LOCAL_CHANGES",
        details: status.stdout.split("\n").filter(Boolean).slice(0, 100)
      });
    }
    currentCommit = commit.stdout.trim();
  }
  return {
    ...row,
    currentCommit,
    repositoryExists,
    healthCheck: row.healthUrl ? {
      id: row.healthId,
      url: row.healthUrl,
      expectedStatus: row.healthExpectedStatus,
      timeoutMs: row.healthTimeoutMs,
      retries: row.healthRetries,
      responseMatch: row.healthResponseMatch
    } : null,
    recoverySnapshot: row.recoverySnapshotId ? {
      id: row.recoverySnapshotId,
      remotePath: row.recoveryRemotePath,
      checksum: row.recoveryChecksum
    } : null
  };
}

export function createDeploymentsRouter({ express, db }) {
  const router = express.Router();

  router.get("/", async (request, response, next) => {
    try {
      const applicationId = request.query.applicationId
        ? idSchema.parse(request.query.applicationId)
        : null;
      const result = await db.query(
        `SELECT d.id, d.project_id AS "projectId", p.name AS "projectName",
         d.operation, d.branch, d.commit_sha AS "commitSha", d.source_commit_sha AS "sourceCommitSha",
         d.target_commit_sha AS "targetCommitSha", d.status, d.plan, d.plan_hash AS "planHash",
         d.started_at AS "startedAt", d.finished_at AS "finishedAt",
         d.output_summary AS "outputSummary", d.error_code AS "errorCode",
         d.error_message AS "errorMessage",
         COALESCE((
           SELECT json_agg(json_build_object(
             'id', s.id, 'stepKey', s.step_key, 'name', s.name, 'position', s.position,
             'status', s.status, 'requiresSudo', s.requires_sudo,
             'startedAt', s.started_at, 'finishedAt', s.finished_at,
             'exitCode', s.exit_code, 'errorMessage', s.error_message
           ) ORDER BY s.position) FROM deployment_steps s WHERE s.deployment_id = d.id
         ), '[]'::json) AS steps
         FROM deployments d JOIN projects p ON p.id = d.project_id
         WHERE ($1::uuid IS NULL OR d.project_id = $1)
         ORDER BY d.started_at DESC LIMIT 100`,
        [applicationId]
      );
      response.json({ deployments: result.rows });
    } catch (error) { next(error); }
  });

  router.post("/plans", requireCsrf, async (request, response, next) => {
    try {
      const input = operationSchema.parse(request.body);
      const application = await applicationForPlan(db, input.applicationId);
      const { plan, hash } = buildDeploymentPlan(application, input.operation);
      const created = await db.transaction(async (transaction) => {
        const deployment = await transaction.query(
          `INSERT INTO deployments
            (project_id, user_id, branch, commit_sha, status, environment_id,
             operation, source_commit_sha, target_commit_sha, initiated_by, plan, plan_hash)
           VALUES (
             $1,$2,$3,$4,'waiting_confirmation',
             (SELECT id FROM environments WHERE application_id = $1 AND is_default = true LIMIT 1),
             $5,$4,NULL,$6,$7::jsonb,$8
           ) RETURNING id`,
          [
            application.id,
            request.user.id,
            application.defaultBranch,
            application.currentCommit || "not-yet-cloned",
            input.operation,
            request.user.email,
            JSON.stringify(plan),
            hash
          ]
        );
        for (let position = 0; position < plan.steps.length; position += 1) {
          const current = plan.steps[position];
          await transaction.query(
            `INSERT INTO deployment_steps
              (deployment_id, step_key, name, position, action, input, requires_sudo)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
            [
              deployment.rows[0].id,
              current.stepKey,
              current.name,
              position,
              current.action,
              JSON.stringify(current.input),
              current.requiresSudo
            ]
          );
        }
        return deployment.rows[0].id;
      });
      await writeAudit(db, request, {
        action: "deployment.plan_created",
        resourceType: "deployment",
        resourceId: created,
        metadata: { applicationId: application.id, operation: input.operation, planHash: hash }
      });
      response.status(201).json({ deploymentId: created, plan, planHash: hash });
    } catch (error) { next(error); }
  });

  router.post("/:deploymentId/confirm", requireCsrf, async (request, response, next) => {
    try {
      const deploymentId = idSchema.parse(request.params.deploymentId);
      const input = confirmSchema.parse(request.body);
      const result = await db.query(
        `UPDATE deployments SET status = 'queued', confirmed_at = now()
         WHERE id = $1 AND plan_hash = $2 AND status = 'waiting_confirmation'
         RETURNING project_id`,
        [deploymentId, input.planHash]
      );
      if (!result.rows[0]) {
        throw Object.assign(new Error("El plan cambió, ya fue confirmado o no existe"), { status: 409 });
      }
      await writeAudit(db, request, {
        action: "deployment.plan_confirmed",
        resourceType: "deployment",
        resourceId: deploymentId,
        metadata: { applicationId: result.rows[0].project_id, planHash: input.planHash }
      });
      response.status(202).json({ deploymentId, status: "queued" });
    } catch (error) { next(error); }
  });

  router.post("/:deploymentId/cancel", requireCsrf, async (request, response, next) => {
    try {
      const deploymentId = idSchema.parse(request.params.deploymentId);
      const result = await db.query(
        `UPDATE deployments SET status = 'cancelled', finished_at = now()
         WHERE id = $1 AND status IN ('waiting_confirmation', 'queued') RETURNING project_id`,
        [deploymentId]
      );
      if (!result.rows[0]) throw Object.assign(new Error("El despliegue ya no se puede cancelar de forma segura"), { status: 409 });
      await writeAudit(db, request, {
        action: "deployment.cancelled",
        resourceType: "deployment",
        resourceId: deploymentId,
        metadata: { applicationId: result.rows[0].project_id }
      });
      response.json({ deploymentId, status: "cancelled" });
    } catch (error) { next(error); }
  });

  return router;
}
