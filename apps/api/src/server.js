import { loadConfig } from "@juanos/config";
import { createApp } from "./app.js";
import { createDatabase } from "./db.js";
import { attachTerminalServer } from "./terminal.js";
import { attachDeploymentLogServer } from "./deployment-ws.js";
import { startDeploymentWorker } from "./deployment-worker.js";
import { attachOperationalLogServer } from "./operational-log-ws.js";
import { startOperationalLogWorker } from "./operational-logs.js";
import { startMaintenanceWorker } from "./maintenance.js";

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const app = createApp({ db, config });
const server = app.listen(config.PORT, "0.0.0.0", () => {
  process.stdout.write(JSON.stringify({ level: "info", message: "JuanOS API ready", port: config.PORT }) + "\n");
});
const terminalServer = attachTerminalServer(server, { db, config });
attachDeploymentLogServer(server, { db, config });
attachOperationalLogServer(server, { db, config });
const stopDeploymentWorker = config.EMBEDDED_WORKER === "1"
  ? startDeploymentWorker({ db, config })
  : async () => {};
const stopOperationalLogWorker = config.EMBEDDED_WORKER === "1"
  ? startOperationalLogWorker({ db, config })
  : async () => {};
const stopMaintenanceWorker = config.EMBEDDED_WORKER === "1"
  ? startMaintenanceWorker({ db, config })
  : async () => {};

async function shutdown(signal) {
  process.stdout.write(JSON.stringify({ level: "info", message: "shutting down", signal }) + "\n");
  await terminalServer.stopTerminals().catch(() => {
    process.stderr.write(JSON.stringify({ level: "error", message: "terminal shutdown persistence failed" }) + "\n");
  });
  await stopDeploymentWorker();
  await stopOperationalLogWorker();
  await stopMaintenanceWorker();
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
