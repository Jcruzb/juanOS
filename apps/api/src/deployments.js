import { z } from "zod";
import { idSchema } from "@juanos/shared";
import { requireCsrf } from "./auth.js";
import { buildDeploymentPlan } from "./deployment-plan.js";
import { applicationForPlan, confirmDeployment } from "./deployment-context.js";
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
      let application, plan, hash;
      const created = await db.transaction(async (transaction) => {
        await transaction.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [input.applicationId]);
        application = await applicationForPlan(transaction, input.applicationId, { operation: input.operation, refreshTarget: ["deploy", "update", "repair"].includes(input.operation) });
        ({ plan, hash } = buildDeploymentPlan(application, input.operation));
        const deployment = await transaction.query(
          `INSERT INTO deployments
            (project_id, user_id, branch, commit_sha, status, environment_id,
             operation, source_commit_sha, target_commit_sha, initiated_by, plan, plan_hash)
           VALUES (
             $1,$2,$3,$4,'waiting_confirmation',
             (SELECT id FROM environments WHERE application_id = $1 AND is_default = true LIMIT 1),
             $5,$4,$9,$6,$7::jsonb,$8
           ) RETURNING id`,
          [
            application.id,
            request.user.id,
            application.defaultBranch,
            application.currentCommit || "not-yet-cloned",
            input.operation,
            request.user.email,
            JSON.stringify(plan),
            hash,
            plan.targetCommitSha
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
        metadata: { applicationId: input.applicationId, operation: input.operation, planHash: hash }
      });
      response.status(201).json({ deploymentId: created, plan, planHash: hash });
    } catch (error) { next(error); }
  });

  router.post("/:deploymentId/confirm", requireCsrf, async (request, response, next) => {
    try {
      const deploymentId = idSchema.parse(request.params.deploymentId);
      const input = confirmSchema.parse(request.body);
      const applicationId = await confirmDeployment(db, deploymentId, input.planHash);
      await writeAudit(db, request, {
        action: "deployment.plan_confirmed",
        resourceType: "deployment",
        resourceId: deploymentId,
        metadata: { applicationId, planHash: input.planHash }
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
