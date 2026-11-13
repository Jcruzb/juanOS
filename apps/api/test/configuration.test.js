import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { branchNameSchema, projectConfigurationPatchSchema, strategyConfigSchema, healthCheckSchema } from "@juanos/shared";
import { createDatabase } from "../src/db.js";
import { createApp } from "../src/app.js";
import { hashToken } from "../src/security.js";

const timestamp = "2026-11-13T12:00:00.000Z";
const patch = {
  confirm: true, expectedUpdatedAt: timestamp, defaultBranch: "codex/repair",
  applicationType: "django", strategy: "systemd", serviceName: "sample.service",
  strategyConfig: { workingDirectory: ".", pythonVenv: "venv", requirements: "requirements.txt",
    collectstatic: false, backupStrategy: "pg_dump_local", serviceName: "sample.service" }
};

test("configuration schema retains real Django options and requires explicit confirmation", () => {
  const parsed = projectConfigurationPatchSchema.parse(patch);
  assert.equal(parsed.strategyConfig.collectstatic, false);
  assert.equal(parsed.strategyConfig.backupStrategy, "pg_dump_local");
  for (const confirm of [false, "true", 1, undefined]) {
    assert.throws(() => projectConfigurationPatchSchema.parse({ ...patch, confirm }));
  }
  assert.throws(() => projectConfigurationPatchSchema.parse({ confirm: true, expectedUpdatedAt: timestamp }));
  assert.throws(() => projectConfigurationPatchSchema.parse({ ...patch, expectedUpdatedAt: "bad" }));
});

test("configuration schema rejects authority changes, secrets and escaping paths", () => {
  for (const key of ["localPath", "repositoryUrl", "slug", "isJuanOS", "hostPolicy", "allowedActions"]) {
    assert.throws(() => projectConfigurationPatchSchema.parse({ ...patch, [key]: "/etc" }), key);
  }
  for (const key of ["legacy", "databasePassword", "databaseBackup", "allowedActions", "configurationReviewedAt"]) {
    assert.throws(() => strategyConfigSchema.parse({ [key]: "forged" }), key);
  }
  for (const path of ["/etc", "../escape", "a/../escape", "C:\\Windows", "a\\b", "a\nb", "a\0b"]) {
    for (const key of ["workingDirectory", "pythonVenv", "requirements", "buildOutputDir"]) {
      assert.throws(() => strategyConfigSchema.parse({ [key]: path }), `${key}:${path}`);
    }
  }
  assert.throws(() => strategyConfigSchema.parse({ nginx: { enabled: true, config: "/etc/nginx" } }));
  assert.throws(() => strategyConfigSchema.parse({ ssl: { activate: true, privateKey: "secret" } }));
  for (const branch of ["-main", "HEAD", "main..evil", "main//evil", "main.lock", ".hidden", "a/.hidden"]) {
    assert.throws(() => branchNameSchema.parse(branch), branch);
  }
  assert.equal(strategyConfigSchema.parse({ pythonVenv: ".venv", requirements: "config/production.txt" }).pythonVenv, ".venv");
});

test("health check accepts HTTP(S) without credentials and rejects unknown fields", () => {
  assert.equal(healthCheckSchema.parse({ url: "https://app.example/api/health" }).expectedStatus, 200);
  for (const url of ["file:///etc/passwd", "https://user:password@app.example", "https://token@app.example"]) {
    assert.throws(() => healthCheckSchema.parse({ url }));
  }
  assert.throws(() => healthCheckSchema.parse({ url: "https://app.example", headers: { authorization: "secret" } }));
});

const databaseUrl = process.env.JUANOS_TEST_DATABASE_URL;
test("configuration API PostgreSQL transaction and session integration", { skip: !databaseUrl }, async (suite) => {
  // Refuse production names even if an operator accidentally passes its URL.
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  assert.match(databaseName, /^juanos_config_test_[a-z0-9_]+$/, "Use a dedicated juanos_config_test_* database, never the production database");
  const admin = createDatabase(databaseUrl);
  const schema = `configuration_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.searchParams.set("options", `-c search_path=${schema},public`);
  const db = createDatabase(isolatedUrl.toString());
  suite.after(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  });
  const migrations = new URL("../migrations/", import.meta.url);
  for (const filename of (await fs.readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
    await db.query(await fs.readFile(new URL(filename, migrations), "utf8"));
  }
  const userId = randomUUID();
  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'config-test@example.com','unused-test-hash')", [userId]);
  const session = "configuration-test-session";
  const csrf = "configuration-test-csrf";
  await db.query(`INSERT INTO app_sessions(user_id,token_hash,csrf_token_hash,expires_at)
    VALUES($1,$2,$3,now()+interval '1 hour')`, [userId, hashToken(session), hashToken(csrf)]);
  const config = { NODE_ENV: "test", PORT: 4000, APP_ORIGIN: "http://localhost", DATABASE_URL: "unused",
    SESSION_SECRET: "a".repeat(32), SESSION_IDLE_MINUTES: 30, PROJECTS_ROOT: "/srv/juanos/projects", TRUST_PROXY: "0" };
  const app = createApp({ db, config });
  const cookies = `juanos_session=${session}; juanos_csrf=${csrf}`;
  const save = (id, data = patch, token = csrf) => request(app).patch(`/api/projects/${id}/configuration`)
    .set("Cookie", cookies).set("x-csrf-token", token).send(data);
  async function project(extraConfig = {}) {
    const id = randomUUID();
    await db.query(`INSERT INTO projects(id,name,slug,local_path,repository_url,default_branch,
      deployment_type,service_name,application_type,updated_at) VALUES($1,'Sample',$2,$3,
      'https://github.com/example/sample','main','systemd','sample.service','django',$4)`,
    [id, `sample-${id}`, `/srv/juanos/projects/${id}`, timestamp]);
    await db.query(`INSERT INTO repositories(application_id,repository_url,default_branch)
      VALUES($1,'https://github.com/example/sample','main')`, [id]);
    await db.query(`INSERT INTO deployment_strategies(application_id,strategy,config) VALUES($1,'systemd',$2::jsonb)`,
      [id, JSON.stringify({ workingDirectory: ".", serviceName: "sample.service", ...extraConfig })]);
    return id;
  }
  async function deployment(id, status) {
    const result = await db.query(`INSERT INTO deployments(project_id,user_id,branch,commit_sha,status)
      VALUES($1,$2,'main',$3,$4) RETURNING id`, [id, userId, "a".repeat(40), status]);
    return result.rows[0].id;
  }

  await suite.test("requires session and CSRF", async () => {
    const id = await project();
    assert.equal((await request(app).patch(`/api/projects/${id}/configuration`).send(patch)).status, 401);
    assert.equal((await save(id, patch, "wrong")).status, 403);
    assert.equal((await save(id, { ...patch, confirm: false })).status, 400);
    const current = await db.query("SELECT default_branch FROM projects WHERE id=$1", [id]);
    assert.equal(current.rows[0].default_branch, "main");
  });

  await suite.test("explicit save cancels reviewed plans and audits atomically without changing host/service registrations", async () => {
    const legacy = { systemdService: "legacy-ignored.service", envFile: "/private/legacy.env" };
    const id = await project({ importedFrom: "jc-deploy", legacy });
    await db.query(`INSERT INTO application_services(application_id,name,service_type,working_directory)
      VALUES($1,'sample.service','systemd','/original/observed')`, [id]);
    await db.query("INSERT INTO host_observability_authorizations(application_id,status) VALUES($1,'authorized')", [id]);
    const planId = await deployment(id, "waiting_confirmation");
    await db.query(`INSERT INTO deployment_steps(deployment_id,step_key,name,position,action)
      VALUES($1,'restart','Restart',0,'systemd_restart')`, [planId]);
    const response = await save(id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.invalidatedPlans, 1);
    assert.equal(response.body.hostPolicyUnchanged, true);
    assert.deepEqual(response.body.application.strategyConfig.legacy, legacy);
    assert.ok(response.body.application.strategyConfig.configurationReviewedAt);
    assert.equal(response.body.application.strategyConfig.serviceName, "sample.service");
    assert.equal((await db.query("SELECT status FROM deployments WHERE id=$1", [planId])).rows[0].status, "cancelled");
    assert.equal((await db.query("SELECT status FROM deployment_steps WHERE deployment_id=$1", [planId])).rows[0].status, "cancelled");
    assert.equal((await db.query("SELECT default_branch FROM repositories WHERE application_id=$1", [id])).rows[0].default_branch, "codex/repair");
    assert.equal((await db.query("SELECT working_directory FROM application_services WHERE application_id=$1", [id])).rows[0].working_directory, "/original/observed");
    assert.equal((await db.query("SELECT status FROM host_observability_authorizations WHERE application_id=$1", [id])).rows[0].status, "authorized");
    const audit = (await db.query("SELECT metadata FROM audit_logs WHERE resource_id=$1 AND action='application.configuration_updated'", [id])).rows[0].metadata;
    assert.equal(audit.hostPolicyUnchanged, true);
    assert.equal(audit.next.strategyConfig.backupStrategy, "pg_dump_local");
    assert.equal(JSON.stringify(audit).includes("/private/legacy.env"), false);
  });

  await suite.test("imported metadata is never silently adopted, malformed edits leave pending plan untouched", async () => {
    const id = await project({ importedFrom: "jc-deploy", legacy: { systemdService: "legacy.service" } });
    const plan = await deployment(id, "waiting_confirmation");
    const partial = await save(id, { confirm: true, expectedUpdatedAt: timestamp, defaultBranch: "new" });
    assert.equal(partial.status, 409);
    assert.equal(partial.body.error.code, "CONFIGURATION_REVIEW_REQUIRED");
    assert.equal((await save(id, { ...patch, strategyConfig: { serviceName: "other.service" } })).status, 400);
    assert.equal((await db.query("SELECT status FROM deployments WHERE id=$1", [plan])).rows[0].status, "waiting_confirmation");
    assert.equal((await db.query("SELECT count(*)::int count FROM audit_logs WHERE resource_id=$1", [id])).rows[0].count, 0);
  });

  await suite.test("active deployments, locks and terminals block editing", async () => {
    for (const state of ["pending", "analyzing", "waiting_sudo", "queued", "running"]) {
      const id = await project();
      await deployment(id, state);
      const response = await save(id);
      assert.equal(response.status, 409, state);
      assert.equal(response.body.error.code, "APPLICATION_BUSY");
    }
    const id = await project();
    await db.query("INSERT INTO terminal_sessions(user_id,project_id) VALUES($1,$2)", [userId, id]);
    assert.equal((await save(id)).body.error.code, "APPLICATION_BUSY");
    const locked = await project();
    const deploymentId = await deployment(locked, "succeeded");
    await db.query(`INSERT INTO deployment_locks(application_id,deployment_id,owner,expires_at)
      VALUES($1,$2,'test',now()+interval '1 minute')`, [locked, deploymentId]);
    assert.equal((await save(locked)).body.error.code, "APPLICATION_BUSY");
  });

  await suite.test("simultaneous saves allow one revision and reject stale overwrite", async () => {
    const id = await project();
    const responses = await Promise.all([save(id), save(id, { ...patch, defaultBranch: "other" })]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(responses.find((r) => r.status === 409).body.error.code, "CONFIGURATION_CHANGED");
    const audits = await db.query("SELECT count(*)::int count FROM audit_logs WHERE resource_id=$1 AND action='application.configuration_updated'", [id]);
    assert.equal(audits.rows[0].count, 1);
  });

  await suite.test("health configuration creates and replaces canonical check; GET roundtrips only accepted keys", async () => {
    const id = await project();
    const first = await save(id, { ...patch, healthCheck: { url: "https://app.example/health", expectedStatus: 200 } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.application.healthCheck, { url: "https://app.example/health", expectedStatus: 200, timeoutMs: 5000, retries: 3 });
    const second = await save(id, { confirm: true, expectedUpdatedAt: first.body.application.updatedAt,
      healthCheck: { url: "http://127.0.0.1:8000/health", expectedStatus: 204, timeoutMs: 1000, retries: 1 } });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const get = await request(app).get(`/api/projects/${id}`).set("Cookie", cookies);
    assert.equal(get.status, 200);
    assert.deepEqual(get.body.application.healthCheck, second.body.application.healthCheck);
    assert.equal((await db.query("SELECT count(*)::int count FROM health_checks WHERE application_id=$1", [id])).rows[0].count, 1);
    assert.equal((await save(id, { ...patch, expectedUpdatedAt: second.body.application.updatedAt, healthCheck: null })).status, 400);
  });

  await suite.test("audit failure rolls back configuration and plan invalidation together", async () => {
    const id = await project();
    const plan = await deployment(id, "waiting_confirmation");
    await db.query(`CREATE FUNCTION reject_configuration_audit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN IF NEW.resource_id='${id}' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`);
    await db.query("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_configuration_audit()");
    const response = await save(id);
    assert.equal(response.status, 500);
    assert.equal((await db.query("SELECT default_branch FROM projects WHERE id=$1", [id])).rows[0].default_branch, "main");
    assert.equal((await db.query("SELECT status FROM deployments WHERE id=$1", [plan])).rows[0].status, "waiting_confirmation");
    await db.query("DROP TRIGGER reject_audit ON audit_logs");
    await db.query("DROP FUNCTION reject_configuration_audit()");
  });
});
