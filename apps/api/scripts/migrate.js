import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@juanos/config";
import { createDatabase } from "../src/db.js";

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const files = (await fs.readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");

for (const file of files) {
  const applied = await db.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
  if (applied.rowCount) continue;
  const sql = await fs.readFile(path.join(directory, file), "utf8");
  await db.transaction(async (transaction) => {
    await transaction.query(sql);
    await transaction.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
  });
}
await db.close();
