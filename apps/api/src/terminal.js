import { WebSocket, WebSocketServer } from "ws";
import pty from "node-pty";
import { parse as parseCookie } from "cookie";
import { createTerminalRuntime } from "./terminal-runtime.js";
import { hashToken } from "./security.js";

const MAX_INPUT_BYTES = 64 * 1024;

export function isAllowedWsOrigin(origin, appOrigin) {
  return typeof origin === "string" && origin === appOrigin;
}

export function terminalOptions(localPath, projectId) {
  return {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: localPath,
    env: {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      HOME: process.env.HOME || "/home/webterminal",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      JUANOS_PROJECT_ID: projectId
    }
  };
}

export function attachTerminalServer(server, { db, config, ptyImpl = pty, runtimeFactory = createTerminalRuntime }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES });

  const sessions = new Map();
  let stopping = false;
  const killSessions = () => {
    stopping = true;
    for (const session of sessions.values()) {
      if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
      session.websocket?.terminate();
      try { session.terminal.kill("SIGKILL"); } catch { /* PTY already exited. */ }
    }
  };
  const runtimeReady = runtimeFactory(db, killSessions);
  // Startup failure disables terminals; HTTP remains available for diagnostics.
  void runtimeReady.catch(() => { stopping = true; });
  wss.stopTerminals = async () => {
    killSessions();
    const runtime = await runtimeReady.catch(() => null);
    await runtime?.stop();
  };

  server.on("upgrade", async (request, socket, head) => {
    try {
      const url = new URL(request.url, config.APP_ORIGIN);
      if (url.pathname !== "/ws/terminal") return;
      const runtime = await runtimeReady;
      if (stopping || !runtime.active) return socket.destroy();
      if (!isAllowedWsOrigin(request.headers.origin, config.APP_ORIGIN)) return socket.destroy();
      const cookies = parseCookie(request.headers.cookie || "");
      const token = cookies.juanos_session;
      const projectId = url.searchParams.get("projectId");
      if (!token || !projectId) return socket.destroy();

      const auth = await db.query(
        `SELECT u.id AS user_id, u.email, u.role, p.id AS project_id, p.local_path
         FROM app_sessions s
         JOIN users u ON u.id = s.user_id
         JOIN projects p ON p.id = $2 AND p.is_active = true
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active = true`,
        [hashToken(token), projectId]
      );
      if (!auth.rows[0]) return socket.destroy();
      request.juanos = auth.rows[0];
      request.resumeId = url.searchParams.get("sessionId");
      wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
    } catch {
      socket.destroy();
    }
  });

  wss.on("connection", (websocket, request) => {
    void (async () => {
    const runtime = await runtimeReady;
    if (stopping || !runtime.active) { websocket.close(1011, "terminal unavailable"); return; }
    const context = request.juanos;
    let session = request.resumeId ? sessions.get(request.resumeId) : null;
    if (session && (session.userId !== context.user_id || session.projectId !== context.project_id)) session = null;

    if (!session) {
      if (config.NODE_ENV === "production" && typeof process.getuid === "function" && process.getuid() === 0) {
        websocket.close(1011, "PTY execution as root is forbidden");
        return;
      }
      const shell = process.env.SHELL && ["/bin/bash", "/bin/zsh", "/bin/sh"].includes(process.env.SHELL)
        ? process.env.SHELL
        : "/bin/bash";
      const created = await db.query(
        `INSERT INTO terminal_sessions (user_id, project_id, remote_ip, runtime_owner_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [context.user_id, context.project_id, request.socket.remoteAddress, runtime.ownerId]
      );
      let terminal;
      try {
        if (stopping || !runtime.active) throw new Error("terminal runtime stopped");
        terminal = ptyImpl.spawn(shell, ["--login"], terminalOptions(context.local_path, context.project_id));
      } catch (error) {
        await db.query("UPDATE terminal_sessions SET status='ended',ended_at=now() WHERE id=$1", [created.rows[0].id]);
        throw error;
      }
      session = {
        id: created.rows[0].id,
        terminal,
        userId: context.user_id,
        projectId: context.project_id,
        websocket: null,
        disconnectTimer: null,
        outputBuffer: ""
      };
      sessions.set(session.id, session);
      terminal.onData((data) => {
        session.outputBuffer = (session.outputBuffer + data).slice(-100_000);
        if (session.websocket?.readyState === WebSocket.OPEN) {
          session.websocket.send(JSON.stringify({ type: "output", data }));
        }
      });
      terminal.onExit(async () => {
        session.ended = true;
        sessions.delete(session.id);
        if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
        await db.query(
          "UPDATE terminal_sessions SET ended_at = now(), status = 'ended' WHERE id = $1",
          [session.id]
        ).catch(() => {});
        session.websocket?.close(1000, "terminal ended");
      });
      try {
      await db.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata, ip_address)
         VALUES ($1, 'terminal.opened', 'terminal_session', $2, $3::jsonb, $4)`,
        [context.user_id, session.id, JSON.stringify({ projectId: context.project_id }), request.socket.remoteAddress]
      );
      } catch (error) {
        terminal.kill("SIGKILL");
        await db.query("UPDATE terminal_sessions SET status='ended',ended_at=now() WHERE id=$1", [session.id]);
        throw error;
      }
      if (stopping || !runtime.active) { terminal.kill("SIGKILL"); websocket.close(1011, "terminal unavailable"); return; }
    } else if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = null;
    }

    session.websocket?.close(1000, "reconnected elsewhere");
    session.websocket = websocket;
    websocket.send(JSON.stringify({ type: "ready", terminalSessionId: session.id, resumed: Boolean(request.resumeId) }));
    if (request.resumeId && session.outputBuffer) websocket.send(JSON.stringify({ type: "output", data: session.outputBuffer }));

    websocket.on("message", async (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === "input" && typeof message.data === "string" && Buffer.byteLength(message.data) <= MAX_INPUT_BYTES) {
          session.terminal.write(message.data);
        } else if (message.type === "resize") {
          const cols = Number(message.cols);
          const rows = Number(message.rows);
          if (Number.isInteger(cols) && cols >= 20 && cols <= 400 && Number.isInteger(rows) && rows >= 5 && rows <= 200) {
            session.terminal.resize(cols, rows);
          }
        } else if (message.type === "signal" && ["SIGINT", "SIGTERM"].includes(message.signal)) {
          session.terminal.kill(message.signal);
        }
      } catch {
        websocket.close(1003, "invalid message");
      }
    });
    websocket.on("close", () => {
      if (session.websocket !== websocket || session.ended || stopping) return;
      session.websocket = null;
      session.disconnectTimer = setTimeout(() => session.terminal.kill("SIGHUP"), 20_000);
      session.disconnectTimer.unref();
    });
    })().catch((error) => {
      process.stderr.write(JSON.stringify({
        level: "error",
        message: "terminal unavailable",
        code: error?.code || "PTY_START_FAILED"
      }) + "\n");
      websocket.close(1011, "terminal unavailable");
    });
  });

  return wss;
}
