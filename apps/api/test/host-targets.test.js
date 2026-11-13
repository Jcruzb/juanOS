import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSystemdDeploymentTarget, assertStaticDeploymentTarget } from "../../../scripts/juanos-host-action";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "juanos-target-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "project"));
  fs.mkdirSync(path.join(root, "other"));
  return root;
}

test("systemd preflight rejects a different checkout before restarting", async (t) => {
  const root = fixture(t);
  const app = { projectPath: path.join(root, "project"), systemd: { service: "example.service" } };
  await assert.rejects(assertSystemdDeploymentTarget(app, async () => ({ stdout: path.join(root, "other") })), /otro directorio/);
  await assert.doesNotReject(assertSystemdDeploymentTarget(app, async () => ({ stdout: path.join(root, "project") })));
});

test("systemd target comparison accepts alternate paths to the same directory", async (t) => {
  const root = fixture(t);
  const alias = path.join(root, "alias");
  fs.symlinkSync(path.join(root, "project"), alias);
  const app = { projectPath: path.join(root, "project"), systemd: { service: "example.service" } };
  await assert.doesNotReject(assertSystemdDeploymentTarget(app, async () => ({ stdout: alias })));
  await assert.rejects(assertSystemdDeploymentTarget(app, async () => ({ stdout: "" })), /absoluto/);
});

test("static preflight preserves an existing directory and accepts a configured release symlink", (t) => {
  const root = fixture(t);
  const current = path.join(root, "current");
  const releaseRoot = path.join(root, "releases");
  fs.mkdirSync(releaseRoot);
  fs.mkdirSync(current);
  const app = { static: { currentSymlink: current, releaseRoot } };
  assert.throws(() => assertStaticDeploymentTarget(app), /directorio existente/);
  assert.equal(fs.statSync(current).isDirectory(), true);
  fs.rmdirSync(current);
  fs.symlinkSync(releaseRoot, current);
  assert.equal(assertStaticDeploymentTarget(app).current, current);
});
