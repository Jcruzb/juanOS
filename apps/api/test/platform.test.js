import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  environmentMetadata,
  fingerprintEnvironment,
  parseEnvironment,
  revealEnvironmentValue,
  updateEnvironmentValue
} from "../src/environment.js";
import { redactSecrets } from "../src/security.js";
import {
  assertSafeDeploymentPlan,
  buildDeploymentPlan,
  deploymentPlanHash
} from "../src/deployment-plan.js";
import {
  discoverApplicationDirectories,
  inspectApplicationDirectory,
  parseComposeServices,
  parseLegacyGlobalIndex
} from "../src/discovery.js";
import { certificateSeverity, parseCertbotCertificates, parseCertbotDryRun } from "../src/certificates.js";
import { buildRecoveryManifest, validateRecoveryManifest } from "../src/recovery.js";
import { readPersistedOutput } from "../src/deployment-ws.js";
import { recoverInterruptedDeployments } from "../src/deployment-worker.js";
import { availableSources, createLogSessionSchema } from "../src/operational-logs.js";
import { projectSchema } from "@juanos/shared";
import { runHostAction } from "../src/host-operations.js";

test("parsea .env sin romper comentarios, orden, comillas ni valores con igual", () => {
  const content = "# cabecera\r\nDATABASE_URL=\"postgres://user:pass@db/app?x=a=b\"\r\nDEBUG = False\r\n\r\n";
  const parsed = parseEnvironment(content);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.eol, "\r\n");
  assert.deepEqual(environmentMetadata(parsed).map((item) => item.key), ["DATABASE_URL", "DEBUG"]);
  assert.equal(revealEnvironmentValue(content, "DATABASE_URL"), "\"postgres://user:pass@db/app?x=a=b\"");
  assert.equal(updateEnvironmentValue(content, "DEBUG", "True").includes("DEBUG =True"), true);
});

test("marca sintaxis no soportada y claves duplicadas para revisión", () => {
  const parsed = parseEnvironment("OK=1\nsource ./other.env\nOK=2\n");
  assert.equal(parsed.valid, false);
  assert.deepEqual(parsed.issues.map((issue) => issue.code).sort(), ["DUPLICATE_KEY", "UNSUPPORTED_SYNTAX"]);
});

test("fingerprint de entorno cambia al modificar el contenido", () => {
  assert.notEqual(fingerprintEnvironment("A=1\n"), fingerprintEnvironment("A=2\n"));
  assert.equal(fingerprintEnvironment("A=1\n").length, 64);
});

test("redacta valores conocidos, bearer, JWT y credenciales en URL", () => {
  const secret = "database-password-value";
  const output = redactSecrets(
    `raw=${secret} Bearer abcdefghijklmnopqrstuvwxyz https://user:pass@example.test aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccc`,
    [secret]
  );
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("pass@example"), false);
  assert.equal(output.includes("Bearer abc"), false);
  assert.match(output, /\[REDACTED\]/);
});

test("genera un plan JuanOS inmutable con recovery antes de modificar", () => {
  const { plan, hash } = buildDeploymentPlan({
    id: "00000000-0000-4000-8000-000000000001",
    slug: "juanos",
    defaultBranch: "main",
    currentCommit: "a".repeat(40),
    strategy: "docker_compose",
    isJuanOS: true,
    healthCheck: { url: "https://juanos.example.test/api/health", expectedStatus: 200, timeoutMs: 5000, retries: 3 }
  }, "update");
  assert.equal(plan.steps[0].action, "recovery_snapshot");
  assert.equal(plan.steps.some((step) => step.action === "self_update"), true);
  assert.equal(deploymentPlanHash(plan), hash);
  assert.doesNotThrow(() => assertSafeDeploymentPlan(plan));
});

test("rechaza comandos arbitrarios dentro de un plan", () => {
  assert.throws(() => assertSafeDeploymentPlan({
    version: 1,
    isJuanOS: false,
    operation: "deploy",
    steps: [{ stepKey: "bad", name: "Bad", action: "application_operation", input: { command: "rm -rf /" } }]
  }), /no permitida|comandos arbitrarios/);
});

test("detecta Docker Compose y ambigüedad con PM2 importado desde JC-Deploy", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "juanos-discovery-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, "sample-app");
  await fs.mkdir(app);
  await fs.writeFile(path.join(app, "package.json"), JSON.stringify({
    name: "sample-app",
    dependencies: { express: "1.0.0" }
  }));
  await fs.writeFile(path.join(app, "compose.yml"), "services:\n  api:\n    build: .\n");
  await fs.writeFile(path.join(app, ".jc-deploy.json"), JSON.stringify({
    appName: "Sample App",
    type: "back",
    repoUrl: "https://github.com/example/sample.git",
    pm2Name: "sample-api"
  }));
  const inspected = await inspectApplicationDirectory(app);
  assert.equal(inspected.applicationType, "backend");
  assert.deepEqual(inspected.indicators.composeServices, ["api"]);
  assert.deepEqual(inspected.strategy.candidates.sort(), ["docker_compose", "pm2"]);
  assert.equal(inspected.confidence, "ambiguous");
  const all = await discoverApplicationDirectories(root);
  assert.equal(all[0].indicators.composeFile, "compose.yml");
});

test("extrae servicios Compose sin interpretar comandos YAML", () => {
  assert.deepEqual(parseComposeServices(`
services:
  web:
    build: .
  api:
    image: example
  worker:
    depends_on:
      - api
volumes:
  data:
`), ["web", "api", "worker"]);
});

test("valida el índice global histórico sin convertirlo en fuente de verdad", () => {
  const entries = parseLegacyGlobalIndex({
    schemaVersion: 1,
    apps: [{ appName: "Legacy", projectPath: "/home/user/apps/legacy", type: "front", status: "online" }]
  });
  assert.equal(entries[0].applicationType, "frontend");
  assert.equal(entries[0].projectPath, "/home/user/apps/legacy");
  assert.throws(() => parseLegacyGlobalIndex({ apps: "not-an-array" }), /array apps/);
});

test("calcula expiración SSL y resultado de Certbot dry-run", () => {
  const output = `Certificate Name: app.example.test
    Domains: app.example.test www.app.example.test
    Expiry Date: 2026-08-07 12:00:00+00:00 (VALID: 10 days)
    Certificate Path: /etc/letsencrypt/live/app/fullchain.pem
    Private Key Path: /etc/letsencrypt/live/app/privkey.pem`;
  const certificates = parseCertbotCertificates(output, new Date("2026-07-28T12:00:00Z"));
  assert.equal(certificates[0].daysRemaining, 10);
  assert.equal(certificates[0].severity, "warning");
  assert.equal(certificateSeverity(3), "critical");
  assert.equal(parseCertbotDryRun("Congratulations, all simulated renewals succeeded.", 0).success, true);
  assert.equal(parseCertbotDryRun("renewal failed", 1).success, false);
});

test("verifica integridad de un recovery y detecta corrupción", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "juanos-recovery-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "database.sql"), "postgres dump");
  await fs.mkdir(path.join(root, "config"));
  await fs.writeFile(path.join(root, "config", "manifest.json"), "{}");
  const manifest = await buildRecoveryManifest(root, ["database.sql", "config/manifest.json"], {
    juanosVersion: "0.1.0"
  });
  assert.equal((await validateRecoveryManifest(root, manifest)).valid, true);
  await fs.writeFile(path.join(root, "database.sql"), "corrupted");
  const invalid = await validateRecoveryManifest(root, manifest);
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(" "), /database\.sql/);
});

test("solo permite reconectar a logs con permisos privados", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "juanos-logs-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "deployment.log");
  await fs.writeFile(target, "safe output", { mode: 0o600 });
  assert.equal(await readPersistedOutput(root, target), "safe output");
  await fs.chmod(target, 0o644);
  await assert.rejects(() => readPersistedOutput(root, target), /Permisos/);
});

test("recuperación del worker distingue despliegue previo a cambios de estado parcial", async () => {
  const queries = [];
  const db = {
    async query(sql) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    }
  };
  await recoverInterruptedDeployments(db);
  assert.match(queries[0], /modifications_started THEN 'partial'/);
  assert.match(queries[0], /ELSE 'queued'/);
  assert.match(queries[1], /DELETE FROM deployment_locks/);
});

test("la migración de plataforma modela commits desplegados, locks y autoprotección", async () => {
  const migration = await fs.readFile(new URL("../migrations/002_platform_foundation.sql", import.meta.url), "utf8");
  assert.match(migration, /deployed_commit_sha/);
  assert.match(migration, /CREATE TABLE deployment_locks/);
  assert.match(migration, /projects_one_juanos_idx/);
  assert.match(migration, /status IN \(\s*'pending', 'analyzing', 'waiting_confirmation'/);
});

test("genera pasos nativos para static, PM2, systemd, Docker y Compose", () => {
  const base = {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "sample",
    defaultBranch: "main",
    currentCommit: "a".repeat(40),
    repositoryExists: true,
    applicationType: "backend",
    isJuanOS: false,
    healthCheck: null,
    serviceName: "sample.service"
  };
  const expectations = [
    ["static_nginx", "frontend", "static_publish"],
    ["pm2", "backend", "pm2_reload"],
    ["systemd", "django", "django_migrate"],
    ["docker", "backend", "docker_recreate"],
    ["docker_compose", "fullstack", "docker_compose_up"]
  ];
  for (const [strategy, applicationType, expectedAction] of expectations) {
    const { plan } = buildDeploymentPlan({
      ...base,
      strategy,
      applicationType,
      strategyConfig: strategy === "systemd"
        ? { serviceName: "sample.service", pythonVenv: "venv" }
        : {}
    }, "deploy");
    assert.equal(plan.steps.some((item) => item.action === expectedAction), true, strategy);
  }
});

test("un plan recovery_test fija snapshot remoto y checksum", () => {
  const { plan } = buildDeploymentPlan({
    id: "00000000-0000-4000-8000-000000000001",
    slug: "juanos",
    defaultBranch: "main",
    strategy: "docker_compose",
    isJuanOS: true,
    recoverySnapshot: {
      id: "00000000-0000-4000-8000-000000000099",
      remotePath: "snapshot.tar.age",
      checksum: "f".repeat(64)
    }
  }, "recovery_test");
  assert.equal(plan.steps[0].action, "recovery_verify");
  assert.equal(plan.steps[0].input.checksum, "f".repeat(64));
});

test("logs operativos solo aceptan fuentes y límites enumerados", () => {
  assert.equal(createLogSessionSchema.parse({ source: "systemd", lines: 500 }).lines, 500);
  assert.throws(() => createLogSessionSchema.parse({ source: "file", lines: 500 }));
  assert.throws(() => createLogSessionSchema.parse({ source: "nginx_error", lines: 999 }));
  const sources = availableSources({
    strategy: "docker_compose",
    config: { services: ["api", "worker"], nginx: { enabled: true } }
  });
  assert.deepEqual(sources.map((item) => item.id), ["docker_compose", "nginx_access", "nginx_error"]);
});

test("el alta valida estrategia, dominio, health y rutas relativas sin comandos", () => {
  const parsed = projectSchema.parse({
    name: "Sample App",
    slug: "sample-app",
    localPath: "/srv/juanos/projects/sample-app",
    repositoryUrl: "https://github.com/example/sample-app.git",
    defaultBranch: "main",
    deploymentType: "docker-compose",
    serviceName: "api",
    applicationType: "fullstack",
    strategy: "docker_compose",
    domain: "sample.example.com",
    strategyConfig: {
      workingDirectory: ".",
      composeFile: "compose.yml",
      port: 4100,
      nginx: { enabled: true }
    },
    healthCheck: { url: "https://sample.example.com/health" }
  });
  assert.equal(parsed.strategyConfig.port, 4100);
  assert.equal(parsed.healthCheck.expectedStatus, 200);
  assert.throws(() => projectSchema.parse({
    ...parsed,
    strategyConfig: { workingDirectory: "../../etc", port: 4100 }
  }));
});

test("migraciones operativas modelan logs broker, puertos y recovery verificable", async () => {
  const operations = await fs.readFile(new URL("../migrations/003_operations.sql", import.meta.url), "utf8");
  const sessions = await fs.readFile(new URL("../migrations/004_operational_sessions.sql", import.meta.url), "utf8");
  assert.match(operations, /CREATE TABLE port_reservations/);
  assert.match(operations, /CREATE TABLE deployment_artifacts/);
  assert.match(sessions, /CREATE TABLE operational_log_sessions/);
  assert.match(sessions, /verification_status/);
  assert.match(sessions, /CREATE TABLE system_observations/);
});

test("sudo queda limitado al helper y nunca recibe contraseña o shell", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "juanos-helper-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const helper = path.join(root, "host-action");
  await fs.writeFile(helper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  let invocation;
  await runHostAction({
    config: {
      JUANOS_HOST_HELPER: helper,
      JUANOS_HOST_HELPER_USE_SUDO: "1",
      NODE_ENV: "test"
    },
    deployment: { slug: "sample" },
    action: "systemd-status",
    parameters: { service: "sample.service" },
    run(executable, args, options) {
      invocation = { executable, args, options };
      return Promise.resolve({ exitCode: 0 });
    }
  });
  assert.equal(invocation.executable, "sudo");
  assert.deepEqual(invocation.args, [
    "-n", helper, "systemd-status", "--application", "sample",
    "--service", "sample.service"
  ]);
  assert.equal(invocation.args.some((value) => /password/i.test(value)), false);
  assert.equal(invocation.options.shell, undefined);
});
