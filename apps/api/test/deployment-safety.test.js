import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../src/git.js";
import { buildDeploymentPlan, assertSafeDeploymentPlan } from "../src/deployment-plan.js";
import { inspectDeploymentRepository, validateDeploymentContext, confirmDeployment } from "../src/deployment-context.js";
import { executePlanStep } from "../src/deployment-worker.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "juanos-plan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin");
  const local = path.join(root, "local");
  await fs.mkdir(origin);
  await runGit(origin, ["init", "-b", "main"]);
  await runGit(origin, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "initial"]);
  await runGit(root, ["clone", origin, local]);
  const row = { id: "app", slug: "sample", localPath: local, repositoryUrl: origin, defaultBranch: "main", strategy: "systemd", applicationType: "django", strategyConfig: { backupStrategy: "pg_dump_local" } };
  const repo = await inspectDeploymentRepository(row, { operation: "update", refreshTarget: true });
  const application = { ...row, ...repo, healthCheck: null };
  const { plan, hash } = buildDeploymentPlan(application, "update");
  const queries = [];
  const db = { query: async (sql) => { queries.push(sql); return { rows: sql.includes("FROM projects p") ? [row] : [] }; } };
  return { root, origin, local, row, application, plan, hash, db, queries };
}

test("plan v2 fija commit revisado; backup obligatorio y legacy bloqueado", async (t) => {
  const f = await fixture(t);
  assert.equal(f.plan.version, 2);
  assert.equal(f.plan.targetCommitSha, f.application.currentCommit);
  assert.equal(f.plan.steps.some((s) => s.action === "git_pull"), false);
  for (const backupStrategy of [undefined, "none"]) assert.throws(() => buildDeploymentPlan({ ...f.application, strategyConfig: { backupStrategy } }, "update"), { code: "DATABASE_BACKUP_REQUIRED" });
  assert.throws(() => buildDeploymentPlan({ ...f.application, strategyConfig: { legacy: {}, backupStrategy: "pg_dump_local" } }, "update"), { code: "APPLICATION_CONFIGURATION_REQUIRED" });
  assert.throws(() => assertSafeDeploymentPlan({ ...f.plan, version: 1 }), { code: "INVALID_PLAN" });
  assert.throws(() => assertSafeDeploymentPlan({ ...f.plan, steps: f.plan.steps.filter((s) => s.action !== "database_backup") }), { code: "DATABASE_BACKUP_REQUIRED" });
});

test("confirma bajo bloqueo proyecto→plan y rechaza configuración cambiada", async (t) => {
  const f = await fixture(t);
  const queries = [];
  const tx = { query: async (sql) => {
    queries.push(sql);
    if (sql.startsWith("SELECT project_id")) return { rows: [{ project_id: "app" }] };
    if (sql.startsWith("SELECT plan,")) return { rows: [{ plan: f.plan, plan_hash: f.hash, status: "waiting_confirmation" }] };
    return f.db.query(sql);
  } };
  const db = { transaction: (fn) => fn(tx) };
  assert.equal(await confirmDeployment(db, "deployment", f.hash), "app");
  assert.ok(queries.findIndex((s) => s.includes("projects WHERE")) < queries.findIndex((s) => s.startsWith("SELECT plan,")));
  f.row.strategyConfig = { backupStrategy: "custom_script" };
  await assert.rejects(confirmDeployment(db, "deployment", f.hash), { code: "STALE_DEPLOYMENT_PLAN" });
});

test("rechaza rama distinta, HEAD avanzado y remoto actualizado después de revisión", async (t) => {
  const f = await fixture(t);
  await runGit(f.local, ["checkout", "-b", "other"]);
  await assert.rejects(validateDeploymentContext(f.db, f.plan), { code: "BRANCH_MISMATCH" });
  await runGit(f.local, ["checkout", "main"]);
  await runGit(f.origin, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "next"]);
  await assert.rejects(validateDeploymentContext(f.db, f.plan, { refreshTarget: true }), { code: "STALE_DEPLOYMENT_PLAN" });
  await runGit(f.local, ["merge", "--ff-only", "FETCH_HEAD"]);
  await assert.rejects(validateDeploymentContext(f.db, f.plan), { code: "STALE_DEPLOYMENT_PLAN" });
});

test("avance exacto conserva rama y migrate no ejecuta sin backup verificado", async (t) => {
  const f = await fixture(t);
  await runGit(f.origin, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "next"]);
  const repository = await inspectDeploymentRepository(f.row, { operation: "update", refreshTarget: true });
  const { plan } = buildDeploymentPlan({ ...f.row, ...repository, healthCheck: null }, "update");
  const deployment = { id: "deployment", applicationId: "app", localPath: f.local, plan };
  await executePlanStep({ db: f.db, config: {}, deployment, step: plan.steps.find((s) => s.action === "git_fast_forward"), publish: async () => {} });
  assert.equal((await runGit(f.local, ["rev-parse", "HEAD"])).stdout.trim(), plan.targetCommitSha);
  assert.equal((await runGit(f.local, ["branch", "--show-current"])).stdout.trim(), "main");
  await assert.rejects(executePlanStep({ db: f.db, config: {}, deployment, step: plan.steps.find((s) => s.action === "django_migrate"), publish: async () => {} }), { code: "DATABASE_BACKUP_REQUIRED" });
});

test("worker marca plan antiguo fallido y libera bloqueo sin ejecutar pasos", async (t) => {
  const { runDeploymentWorkerOnce } = await import("../src/deployment-worker.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "juanos-worker-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.startsWith("SELECT p.id FROM projects")) return { rows: [{ id: "app" }] };
    if (sql.includes('d.plan_hash AS "planHash"')) return { rows: [{ id: "job", applicationId: "app", operation: "update", plan: { version: 1, steps: [] } }] };
    return { rows: [] };
  } };
  db.transaction = (fn) => fn(db);
  assert.equal(await runDeploymentWorkerOnce({ db, config: { DEPLOY_LOGS_DIR: root }, workerId: "test" }), true);
  const finished = calls.find((c) => c.sql.includes("status = $2, finished_at"));
  assert.equal(finished.values[1], "failed");
  assert.equal(finished.values[2], "INVALID_PLAN");
  assert.equal(calls.some((c) => c.sql.includes("modifications_started = true")), false);
  assert.equal(calls.some((c) => c.sql.includes("DELETE FROM deployment_locks WHERE deployment_id")), true);
});


test("recovery y verificación siguen disponibles con configuración legacy y cambios locales", async (t) => {
  const f = await fixture(t);
  f.row.strategyConfig = { legacy: { deploymentType: "old" } };
  f.row.strategy = null;
  f.row.recoverySnapshotId = "snapshot";
  f.row.recoveryRemotePath = "snapshot.tar.age";
  f.row.recoveryChecksum = "f".repeat(64);
  await fs.writeFile(path.join(f.local, "pending.txt"), "local work");
  const { applicationForPlan } = await import("../src/deployment-context.js");
  for (const operation of ["recovery", "recovery_test", "ssl_test"]) {
    const application = await applicationForPlan(f.db, "app", { operation });
    const { plan } = buildDeploymentPlan(application, operation);
    assert.equal(plan.targetCommitSha, null);
    assert.equal(plan.steps.some((step) => step.action.startsWith("git_")), false);
    await assert.doesNotReject(validateDeploymentContext(f.db, plan));
  }
  await assert.rejects(applicationForPlan(f.db, "app", { operation: "update", refreshTarget: true }), { code: "APPLICATION_CONFIGURATION_REQUIRED" });
  f.row.strategy = "systemd";
  f.row.strategyConfig = { backupStrategy: "pg_dump_local", configurationReviewedAt: new Date().toISOString() };
  await assert.rejects(applicationForPlan(f.db, "app", { operation: "update", refreshTarget: true }), { code: "LOCAL_CHANGES" });
});

test("rollback y restart permiten legacy sin el marcador pero exigen estrategia válida", async (t) => {
  const f = await fixture(t);
  const application = { ...f.application, strategy: "static_nginx", strategyConfig: { legacy: {} } };
  for (const operation of ["rollback", "restart"]) {
    assert.doesNotThrow(() => buildDeploymentPlan(application, operation));
    assert.throws(() => buildDeploymentPlan({ ...application, strategy: null }, operation), { code: "APPLICATION_CONFIGURATION_REQUIRED" });
  }
});
