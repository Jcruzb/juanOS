import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git.js";
import { assertNormalizedApplication, deploymentConfigurationHash, deploymentPlanHash, assertSafeDeploymentPlan } from "./deployment-plan.js";

const codeOperations = new Set(["deploy", "update", "repair"]);
const shaPattern = /^[a-f0-9]{40}$/;
function conflict(code, message) { return Object.assign(new Error(message), { code, status: 409 }); }
function repositoryIdentity(value) {
  const normalized = String(value || "").replace(/^git@([^:]+):/, "ssh://git@$1/");
  try { const url = new URL(normalized); return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/?(?:\.git)?$/, "")}`; }
  catch { return normalized.replace(/\/?(?:\.git)?$/, ""); }
}

export async function inspectDeploymentRepository(application, { operation = "", refreshTarget = false } = {}) {
  const { localPath, defaultBranch, repositoryUrl } = application;
  const repositoryExists = await fs.stat(path.join(localPath, ".git")).then(() => true, () => false);
  const updating = codeOperations.has(operation);
  if (updating) {
    try { await runGit(path.parse(localPath).root, ["check-ref-format", "--branch", defaultBranch]); }
    catch { throw conflict("INVALID_BRANCH", "La rama configurada no es una rama Git válida."); }
  }
  let currentCommit = null;
  let currentBranch = null;
  let repositoryOrigin = null;
  let targetCommit = null;
  if (repositoryExists) {
    currentCommit = (await runGit(localPath, ["rev-parse", "HEAD"])).stdout.trim();
    currentBranch = (await runGit(localPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim() || null;
    const status = await runGit(localPath, ["status", "--porcelain=v1"]);
    if (updating && status.stdout.trim()) throw conflict("LOCAL_CHANGES", "Hay cambios locales; revísalos antes de generar o ejecutar el plan.");
    if (updating) {
      if (currentBranch !== defaultBranch) throw conflict("BRANCH_MISMATCH", `La copia está en ${currentBranch || "HEAD separado"}, pero la configuración indica ${defaultBranch}. Alinea la rama y genera otro plan.`);
      repositoryOrigin = (await runGit(localPath, ["remote", "get-url", "origin"])).stdout.trim();
      if (repositoryIdentity(repositoryOrigin) !== repositoryIdentity(repositoryUrl)) throw conflict("REPOSITORY_MISMATCH", "El remoto origin no coincide con el repositorio configurado. Revisa la configuración.");
      if (refreshTarget) {
        await runGit(localPath, ["fetch", "--no-tags", "origin", `refs/heads/${defaultBranch}`]);
        targetCommit = (await runGit(localPath, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).stdout.trim();
        try { await runGit(localPath, ["merge-base", "--is-ancestor", currentCommit, targetCommit]); }
        catch { throw conflict("BRANCH_DIVERGED", "La copia local no puede avanzar al commit remoto sin perder o mezclar cambios. Resuelve la divergencia y genera otro plan."); }
      }
    }
  } else if (updating && refreshTarget) {
    const remote = await runGit(path.parse(localPath).root, ["ls-remote", "--exit-code", repositoryUrl, `refs/heads/${defaultBranch}`]);
    const matches = remote.stdout.trim().split("\n").map((line) => line.split(/\s+/)).filter((row) => row[1] === `refs/heads/${defaultBranch}`);
    if (matches.length !== 1) throw conflict("TARGET_COMMIT_UNAVAILABLE", "No se puede resolver la rama remota configurada.");
    targetCommit = matches[0][0];
  }
  if (updating && refreshTarget && !shaPattern.test(targetCommit || "")) throw conflict("TARGET_COMMIT_UNAVAILABLE", "No se pudo fijar un commit remoto válido para revisión.");
  return { repositoryExists, currentCommit, currentBranch, repositoryOrigin, targetCommit };
}

export async function applicationForPlan(db, id, { operation = "", refreshTarget = false } = {}) {
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
     LEFT JOIN deployment_strategies ds ON ds.application_id = p.id
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
  if (!result.rows[0]) throw Object.assign(new Error("Aplicación no encontrada o inactiva"), { status: 404 });
  const row = result.rows[0];
  assertNormalizedApplication(row, operation);
  const repository = await inspectDeploymentRepository(row, { operation, refreshTarget });
  return {
    ...row,
    ...repository,
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


export async function validateDeploymentContext(db, plan, { refreshTarget = false, codeUpdated = false } = {}) {
  assertSafeDeploymentPlan(plan);
  const application = await applicationForPlan(db, plan.applicationId, { operation: plan.operation, refreshTarget });
  if (deploymentConfigurationHash(application) !== plan.configurationHash) throw conflict("STALE_DEPLOYMENT_PLAN", "La configuración cambió desde la revisión. Genera y confirma un nuevo plan.");
  const expectedCommit = codeUpdated ? plan.targetCommitSha : plan.sourceCommitSha;
  const expectedBranch = codeUpdated ? plan.targetBranch : plan.sourceBranch;
  if (application.currentCommit !== expectedCommit || application.currentBranch !== expectedBranch || application.repositoryExists !== (codeUpdated ? true : plan.repositoryExists)) throw conflict("STALE_DEPLOYMENT_PLAN", "La rama o HEAD cambió desde la revisión. Genera y confirma un nuevo plan.");
  if (plan.repositoryOrigin && application.repositoryOrigin !== plan.repositoryOrigin) throw conflict("STALE_DEPLOYMENT_PLAN", "El remoto cambió desde la revisión. Genera y confirma un nuevo plan.");
  if (refreshTarget && application.targetCommit !== plan.targetCommitSha) throw conflict("STALE_DEPLOYMENT_PLAN", "La rama remota avanzó desde la revisión. Revisa un nuevo plan con el commit actual.");
  return application;
}

export async function confirmDeployment(db, deploymentId, planHash) {
  return db.transaction(async (transaction) => {
    const lookup = await transaction.query("SELECT project_id FROM deployments WHERE id = $1", [deploymentId]);
    if (!lookup.rows[0]) throw conflict("STALE_DEPLOYMENT_PLAN", "El plan no existe.");
    await transaction.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [lookup.rows[0].project_id]);
    const selected = await transaction.query("SELECT plan, plan_hash, status FROM deployments WHERE id = $1 FOR UPDATE", [deploymentId]);
    const stored = selected.rows[0];
    if (!stored || stored.status !== "waiting_confirmation" || stored.plan_hash !== planHash || deploymentPlanHash(stored.plan) !== planHash) throw conflict("STALE_DEPLOYMENT_PLAN", "El plan cambió o ya fue confirmado. Genera un nuevo plan.");
    await validateDeploymentContext(transaction, stored.plan, { refreshTarget: codeOperations.has(stored.plan.operation) });
    await transaction.query("UPDATE deployments SET status = 'queued', confirmed_at = now() WHERE id = $1", [deploymentId]);
    return lookup.rows[0].project_id;
  });
}
