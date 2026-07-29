import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { assertProjectPath, redactSecrets } from "../src/security.js";
import { resolveSafePath, validateRelativePath } from "../src/project-paths.js";
import { gitArgsForAction } from "../src/git.js";
import { attachTerminalServer, isAllowedWsOrigin, terminalOptions } from "../src/terminal.js";
import { validateDeployScript } from "../src/deployments.js";
import { fileDeleteSchema, fileEntrySchema, fileRenameSchema, fileSearchSchema } from "@juanos/shared";

test("permite una ruta hija del directorio de proyectos", () => {
  assert.equal(assertProjectPath("/srv/juanos/projects", "/srv/juanos/projects/app"), "/srv/juanos/projects/app");
});

test("bloquea path traversal y rutas hermanas", () => {
  assert.throws(
    () => assertProjectPath("/srv/juanos/projects", "/srv/juanos/projects/../../etc"),
    /PROJECTS_ROOT/
  );
  assert.throws(
    () => assertProjectPath("/srv/juanos/projects", "/srv/juanos/projects-evil/app"),
    /PROJECTS_ROOT/
  );
});

test("redacta credenciales y claves en logs", () => {
  const clean = redactSecrets("token=ghp_1234567890abcdefghijkl password=hunter2 api_key=sk-example123456789");
  assert.equal(clean.includes("hunter2"), false);
  assert.equal(clean.includes("ghp_1234567890"), false);
  assert.match(clean, /\[REDACTED\]/);
});

test("bloquea archivos sensibles y traversal en el editor", () => {
  assert.throws(() => validateRelativePath("../etc/passwd"), /bloqueada|válida/);
  assert.throws(() => validateRelativePath(".env"), /bloqueada/);
  assert.throws(() => validateRelativePath("keys/id_ed25519"), /bloqueada/);
  assert.equal(validateRelativePath("src/app.js"), "src/app.js");
});

test("valida creación, búsqueda, renombrado y confirmación de borrado", () => {
  assert.equal(fileEntrySchema.parse({ path: "src/new.js", type: "file" }).type, "file");
  assert.equal(fileRenameSchema.parse({ path: "src/a.js", newPath: "src/b.js" }).newPath, "src/b.js");
  assert.equal(fileSearchSchema.parse({ query: "JuanOS" }).maxResults, 100);
  assert.throws(() => fileDeleteSchema.parse({ path: "src/a.js", confirm: false }));
  assert.throws(() => fileEntrySchema.parse({ path: "../escape", type: "directory" }));
});

test("construye operaciones Git con argumentos separados y sin force", () => {
  assert.deepEqual(gitArgsForAction({ action: "pull" }), ["pull", "--ff-only"]);
  assert.deepEqual(gitArgsForAction({ action: "stage", paths: ["src/a.js"] }), ["add", "--", "src/a.js"]);
  assert.equal(gitArgsForAction({ action: "push" }).includes("--force"), false);
  assert.throws(() => gitArgsForAction({ action: "reset-hard" }), /no permitida/);
});

test("impide leer mediante un symlink que sale del proyecto", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "juanos-path-"));
  const project = path.join(base, "project");
  const outside = path.join(base, "outside.txt");
  await fs.mkdir(project);
  await fs.writeFile(outside, "private");
  await fs.symlink(outside, path.join(project, "escape.txt"));
  await assert.rejects(() => resolveSafePath(project, "escape.txt"), /fuera del proyecto/);
  await fs.rm(base, { recursive: true, force: true });
});

test("la terminal usa cwd del servidor y exige el origen exacto", () => {
  const options = terminalOptions("/srv/juanos/projects/app", "project-id");
  assert.equal(options.cwd, "/srv/juanos/projects/app");
  assert.equal(options.env.JUANOS_PROJECT_ID, "project-id");
  assert.equal(options.env.USER, undefined);
  assert.equal(isAllowedWsOrigin("https://os.example.com", "https://os.example.com"), true);
  assert.equal(isAllowedWsOrigin("https://evil.example", "https://os.example.com"), false);
});

test("WebSocket autenticado crea una PTY y transmite salida", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "juanos-terminal-"));
  const sessionId = "00000000-0000-4000-8000-000000000010";
  const db = {
    async query(sql) {
      if (sql.includes("FROM app_sessions")) {
        return { rows: [{ user_id: "user-1", email: "admin@example.com", role: "admin", project_id: "project-1", local_path: project }] };
      }
      if (sql.includes("INSERT INTO terminal_sessions")) return { rows: [{ id: sessionId }] };
      return { rows: [], rowCount: 1 };
    }
  };
  let onData = () => {};
  let onExit = () => {};
  const terminal = {
    onData(callback) { onData = callback; },
    onExit(callback) { onExit = callback; },
    write(data) {
      if (data.includes("printf")) setImmediate(() => onData("JUANOS_PTY_OK\n"));
      if (data.includes("exit")) setImmediate(() => onExit({ exitCode: 0, signal: 0 }));
    },
    resize() {},
    kill() { setImmediate(() => onExit({ exitCode: 0, signal: 1 })); }
  };
  const ptyImpl = { spawn: () => terminal };
  const server = http.createServer();
  const wss = attachTerminalServer(server, { db, config: { APP_ORIGIN: "http://localhost", NODE_ENV: "test" }, ptyImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?projectId=project-1`, {
    origin: "http://localhost",
    headers: { cookie: "juanos_session=test-token" }
  });
  const output = await new Promise((resolve, reject) => {
    let received = "";
    const timeout = setTimeout(() => reject(new Error("La PTY no devolvió salida")), 5000);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "ready") {
        assert.equal(message.terminalSessionId, sessionId);
        socket.send(JSON.stringify({ type: "input", data: "printf 'JUANOS_PTY_OK\\n'\r" }));
      }
      if (message.type === "output") {
        received += message.data;
        if (received.includes("JUANOS_PTY_OK")) {
          clearTimeout(timeout);
          resolve(received);
          socket.send(JSON.stringify({ type: "input", data: "exit\r" }));
        }
      }
    });
    socket.on("error", reject);
  });
  assert.match(output, /JUANOS_PTY_OK/);
  await new Promise((resolve) => socket.once("close", resolve));
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(project, { recursive: true, force: true });
});

test("rechaza ejecutores de despliegue modificables por grupo u otros", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "juanos-deploy-"));
  const script = path.join(directory, "example");
  await fs.writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o777 });
  await fs.chmod(script, 0o777);
  await assert.rejects(() => validateDeployScript(directory, "example"), /inseguro/);
  await fs.rm(directory, { recursive: true, force: true });
});

test("la migración impide dos despliegues activos del mismo proyecto", async () => {
  const migration = await fs.readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
  assert.match(migration, /UNIQUE INDEX deployments_one_active_per_project_idx/);
  assert.match(migration, /status IN \('queued', 'running'\)/);
});

test("self-update instala herramientas de build aunque el worker esté en producción", async () => {
  const script = await fs.readFile(
    new URL("../../../scripts/juanos-self-update", import.meta.url),
    "utf8"
  );
  assert.match(script, /command\("npm", \["ci", "--include=dev"\]/);
});
