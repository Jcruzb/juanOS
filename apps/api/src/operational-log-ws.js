import fs from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { parse as parseCookie } from "cookie";
import { hashToken } from "./security.js";

export function attachOperationalLogServer(server, { db, config }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on("upgrade", async (request, socket, head) => {
    try {
      const url = new URL(request.url, config.APP_ORIGIN);
      if (url.pathname !== "/ws/logs") return;
      if (request.headers.origin !== config.APP_ORIGIN) return socket.destroy();
      const token = parseCookie(request.headers.cookie || "").juanos_session;
      const sessionId = url.searchParams.get("id");
      if (!token || !sessionId) return socket.destroy();
      const result = await db.query(
        `SELECT ls.id, ls.status, ls.log_path AS "logPath"
         FROM app_sessions s
         JOIN operational_log_sessions ls ON ls.user_id = s.user_id AND ls.id = $2
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
           AND ls.expires_at > now()`,
        [hashToken(token), sessionId]
      );
      if (!result.rows[0]) return socket.destroy();
      request.logSession = result.rows[0];
      wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
    } catch {
      socket.destroy();
    }
  });
  wss.on("connection", (websocket, request) => {
    tailSession(websocket, request.logSession.id, db, config).catch(() => websocket.close());
  });
  return wss;
}

async function tailSession(websocket, sessionId, db, config) {
  let offset = 0;
  let closed = false;
  websocket.on("close", () => { closed = true; });
  while (!closed) {
    const result = await db.query(
      `SELECT status, log_path AS "logPath", error
       FROM operational_log_sessions WHERE id = $1`,
      [sessionId]
    );
    const session = result.rows[0];
    if (!session) return websocket.close();
    if (session.logPath) {
      const target = safeLogPath(config.DEPLOY_LOGS_DIR, session.logPath);
      const chunk = await readFromOffset(target, offset).catch(() => null);
      if (chunk) {
        offset = chunk.offset;
        if (chunk.data) websocket.send(JSON.stringify({ type: "output", data: chunk.data }));
      }
    }
    if (["finished", "failed", "cancelled"].includes(session.status)) {
      websocket.send(JSON.stringify({ type: "end", status: session.status, error: session.error }));
      return websocket.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function safeLogPath(rootDirectory, storedPath) {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(root, storedPath);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Ruta de log inválida");
  return target;
}

async function readFromOffset(target, offset) {
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

export { safeLogPath, readFromOffset };
