import test from "node:test";
import assert from "node:assert/strict";
import { buildDeploymentPlan } from "../src/deployment-plan.js";

for (const strategy of ["docker", "docker_compose"]) {
  test(`${strategy} publishes nginx and SSL before checking health`, () => {
    const application = {
      id: "00000000-0000-4000-8000-000000000001", slug: "juandb", strategy,
      defaultBranch: "main", applicationType: "fullstack", repositoryExists: false,
      strategyConfig: { composeFile: "compose.yml", port: 8743, nginx: { enabled: true }, ssl: { activate: true, domain: "juandb.example.com" } },
      healthCheck: { url: "https://juandb.example.com/health" }
    };
    const actions = buildDeploymentPlan(application, "deploy").plan.steps.map(s => s.action);
    for (const action of ["nginx_configure", "nginx_validate_reload", "dns_validate", "http_port_validate", "certbot_issue"]) {
      assert.equal(actions.filter(a => a === action).length, 1);
      assert.ok(actions.indexOf(action) < actions.indexOf("health_check"));
    }
    const restart = buildDeploymentPlan(application, "restart").plan.steps.map(s => s.action);
    assert.ok(!restart.includes("certbot_issue"));
    application.strategyConfig.nginx.enabled = false;
    application.strategyConfig.ssl.activate = false;
    assert.ok(!buildDeploymentPlan(application, "deploy").plan.steps.some(s => s.action === "nginx_configure"));
  });
}

for (const operation of ["update", "repair"]) {
  test(`${operation} retains a running application's port instead of requiring it free`, () => {
    const application = {
      id: "00000000-0000-4000-8000-000000000001", slug: "juandb",
      strategy: "docker_compose", defaultBranch: "main", applicationType: "fullstack",
      repositoryExists: true, currentCommit: "a".repeat(40),
      strategyConfig: { port: 8743, composeFile: "compose.yml", nginx: { enabled: true } },
      healthCheck: { url: "https://juandb.example.com/health" }
    };
    const steps = buildDeploymentPlan(application, operation).plan.steps;
    assert.ok(!steps.some(s => s.action === "port_check"));
    assert.ok(steps.some(s => s.action === "docker_compose_up"));
    assert.ok(steps.some(s => s.action === "nginx_configure"));
    assert.equal(application.strategyConfig.port, 8743);
    assert.ok(steps.some(s => s.action === "health_check"));
    assert.ok(buildDeploymentPlan(application, "deploy").plan.steps.some(s => s.action === "port_check"));
    application.repositoryExists = false;
    assert.ok(buildDeploymentPlan(application, operation).plan.steps.some(s => s.action === "port_check"));
  });
}
