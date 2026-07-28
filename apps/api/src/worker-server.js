import { loadConfig } from "@juanos/config";
import { createDatabase } from "./db.js";
import { startDeploymentWorker } from "./deployment-worker.js";
import { startOperationalLogWorker } from "./operational-logs.js";
import { startMaintenanceWorker } from "./maintenance.js";

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const stop = startDeploymentWorker({ db, config });
const stopLogs = startOperationalLogWorker({ db, config });
const stopMaintenance = startMaintenanceWorker({ db, config });
process.stdout.write(JSON.stringify({
  level: "info",
  message: "JuanOS deployment worker ready",
  pid: process.pid
}) + "\n");

async function shutdown(signal) {
  process.stdout.write(JSON.stringify({ level: "info", message: "worker shutting down", signal }) + "\n");
  await stop();
  await stopLogs();
  await stopMaintenance();
  await db.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
