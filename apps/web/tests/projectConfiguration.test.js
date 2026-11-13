import test from "node:test";
import assert from "node:assert/strict";
import { configurationForm, configurationChanges, configurationPayload, configurationReview } from "../src/projectConfiguration.js";
const application = { id: "app", updatedAt: "2026-11-13T12:00:00.000Z", defaultBranch: "main", applicationType: "django", strategy: "systemd", serviceName: "controlants", localPath: "/srv/managed", strategyConfig: { nginx: { enabled: true }, pythonVenv: ".venv", backupStrategy: "none", legacy: { serviceName: "old" }, importedFrom: "/var/www/legacy", serviceName: "controlants" } };
test("branch change preserves nested configuration and never sends host paths or permissions", () => {
  const form = { ...configurationForm(application), defaultBranch: "codex/integration" };
  const payload = configurationPayload(application, form);
  assert.deepEqual(payload.strategyConfig, { nginx: { enabled: true }, pythonVenv: ".venv", backupStrategy: "none", serviceName: "controlants" });
  assert.equal(payload.strategyConfig.legacy, undefined);
  assert.equal(payload.strategyConfig.importedFrom, undefined);
  assert.equal(payload.expectedUpdatedAt, application.updatedAt);
  assert.equal(payload.confirm, true);
  assert.equal(payload.localPath, undefined);
  assert.equal(payload.repositoryUrl, undefined);
  assert.equal(payload.hostPolicy, undefined);
  assert.deepEqual(configurationChanges(application, form).map((change) => change.key), ["defaultBranch"]);
});
test("Django and service edits survive the complete replacement without erasing unrelated config", () => {
  const form = { ...configurationForm(application), pythonVenv: "venv", collectstatic: false, backupStrategy: "pg_dump_local", serviceName: "controlants-gunicorn" };
  const payload = configurationPayload(application, form);
  assert.equal(payload.strategyConfig.serviceName, "controlants-gunicorn");
  assert.equal(payload.strategyConfig.collectstatic, false);
  assert.equal(payload.strategyConfig.backupStrategy, "pg_dump_local");
  assert.equal(payload.strategyConfig.legacy, undefined);
  assert.deepEqual(application.strategyConfig.nginx, { enabled: true });
  assert.equal(application.strategyConfig.pythonVenv, ".venv");
});
test("review reflects actual changed frontend output and does not insert unused defaults", () => {
  const app = { ...application, applicationType: "frontend", strategy: "static_nginx", strategyConfig: {} };
  const form = configurationForm(app);
  assert.deepEqual(configurationChanges(app, form), []);
  assert.deepEqual(configurationPayload(app, form).strategyConfig, {});
  form.buildOutputDir = "build";
  assert.deepEqual(configurationPayload(app, form).strategyConfig, { buildOutputDir: "build" });
  assert.equal(configurationChanges(app, form)[0].before, "dist");
});

test("health URL update preserves timeouts and does not invent a readiness URL", () => {
  assert.equal(configurationPayload(application, configurationForm(application)).healthCheck, undefined);
  const app = { ...application, healthCheck: { id: "health-row", status: "healthy", url: "https://old.example/health", expectedStatus: 204, timeoutMs: 7000, retries: 4 } };
  const form = { ...configurationForm(app), healthUrl: "https://app.example/health", healthExpectedStatus: 200 };
  const payload = configurationPayload(app, form);
  assert.deepEqual(payload.healthCheck, { url: "https://app.example/health", expectedStatus: 200, timeoutMs: 7000, retries: 4 });
  assert.deepEqual(configurationChanges(app, form).map((change) => change.key), ["healthUrl", "healthExpectedStatus"]);
});

test("unchanged imported settings can be explicitly reviewed in full without promoting legacy metadata", () => {
  const form = configurationForm(application);
  const review = configurationReview(application, form);
  assert.equal(review.fullReview, true);
  assert.deepEqual(review.changes, []);
  assert.ok(review.settings.some((setting) => setting.key === "strategyConfig"));
  assert.ok(review.settings.some((setting) => setting.key === "defaultBranch" && setting.value === "main"));
  assert.equal(review.payload.confirm, true);
  assert.equal(review.payload.strategyConfig.legacy, undefined);
  assert.equal(review.payload.strategyConfig.configurationReviewedAt, undefined);
  const reviewed = { ...application, strategyConfig: { ...application.strategyConfig, configurationReviewedAt: "2026-11-13T13:00:00Z" } };
  assert.equal(configurationReview(reviewed, configurationForm(reviewed)), null);
});

test("an inconsistent systemd service override is explicitly reviewed and reconciled", () => {
  const app = { ...application, strategyConfig: { ...application.strategyConfig, serviceName: "legacy-unit" } };
  const form = configurationForm(app);
  const review = configurationReview(app, form);
  assert.ok(review.changes.some((change) => change.key === "strategyServiceName" && change.before === "legacy-unit" && change.after === "controlants"));
  assert.equal(review.payload.strategyConfig.serviceName, review.payload.serviceName);
});
