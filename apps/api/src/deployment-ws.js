import fs from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { parse as parseCookie } from "cookie";
import { hashToken } from "./security.js";
import { deploymentStreams } from "./deployments.js";

export function attachDeploymentLogServer(server, { db, config }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on("upgrade", async (request, socket, head) => {
    try {
      const url = new URL(request.url, config.APP_ORIGIN);
      if (url.pathname !== "/ws/deployments") return;
      if (request.headers.origin !== config.APP_ORIGIN) return socket.destroy();
      const token = parseCookie(request.headers.cookie || "").juanos_session;
      const deploymentId = url.searchParams.get("id");
      if (!token || !deploymentId) return socket.destroy();
      const allowed = await db.query(
        `SELECT d.id, d.log_path, d.status FROM app_sessions s JOIN deployments d ON d.id = $2
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
        [hashToken(token), deploymentId]
      );
      if (!allowed.rows[0]) return socket.destroy();
      request.deploymentId = deploymentId;
      request.deployment = allowed.rows[0];
      wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
    } catch { socket.destroy(); }
  });
  wss.on("connection", async (websocket, request) => {
    const stream = await waitForStream(request.deploymentId, request.deployment.status);
    if (!stream) {
      return tailPersistedDeployment(websocket, request.deploymentId, db, config);
    }
    websocket.send(JSON.stringify({
      type: "output",
      data: typeof stream.output === "function" ? stream.output() : stream.output
    }));
    const send = (data) => websocket.readyState === websocket.OPEN && websocket.send(JSON.stringify({ type: "output", data }));
    stream.listeners.add(send);
    if (stream.done) websocket.send(JSON.stringify({ type: "end" }));
    websocket.on("close", () => stream.listeners.delete(send));
  });
  return wss;
}

async function tailPersistedDeployment(websocket, deploymentId, db, config) {
  let offset = 0;
  let closed = false;
  websocket.on("close", () => { closed = true; });
  while (!closed) {
    const result = await db.query(
      `SELECT status, log_path AS "logPath", error_message AS error
       FROM deployments WHERE id = $1`,
      [deploymentId]
    );
    const deployment = result.rows[0];
    if (!deployment) return websocket.close();
    if (deployment.logPath) {
      const target = safePersistedLogPath(config.DEPLOY_LOGS_DIR, deployment.logPath);
      const chunk = await readLogChunk(target, offset).catch(() => null);
      if (chunk) {
        offset = chunk.offset;
        if (chunk.data) websocket.send(JSON.stringify({ type: "output", data: chunk.data }));
      }
    }
    if (!["pending", "analyzing", "waiting_confirmation", "waiting_sudo", "queued", "running"].includes(deployment.status)) {
      websocket.send(JSON.stringify({ type: "end", status: deployment.status, error: deployment.error }));
      return websocket.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function waitForStream(deploymentId, status) {
  let stream = deploymentStreams.get(deploymentId);
  if (stream || !["queued", "running"].includes(status)) return stream;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    stream = deploymentStreams.get(deploymentId);
    if (stream) return stream;
  }
  return null;
}

async function readPersistedOutput(logsDirectory, storedPath) {
  if (!storedPath) return "";
  const target = safePersistedLogPath(logsDirectory, storedPath);
  const stat = await fs.stat(target);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Permisos de log inseguros");
  const content = await fs.readFile(target, "utf8");
  return content.slice(-1_000_000);
}

function safePersistedLogPath(logsDirectory, storedPath) {
  const root = path.resolve(logsDirectory);
  const target = path.resolve(path.isAbsolute(storedPath) ? storedPath : path.join(root, storedPath));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Ruta de log inválida");
  return target;
}

async function readLogChunk(target, offset) {
  const stat = await fs.stat(target);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Permisos de log inseguros");
  if (stat.size <= offset) return { offset, data: "" };
  const length = Math.min(stat.size - offset, 256_000);
  const handle = await fs.open(target, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return { offset: offset + bytesRead, data: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await handle.close();
  }
}

export { readPersistedOutput, readLogChunk, safePersistedLogPath, tailPersistedDeployment };
