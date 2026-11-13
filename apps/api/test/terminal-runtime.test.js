import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createTerminalRuntime, reconcileTerminalOwners } from "../src/terminal-runtime.js";

function database() {
  const client = new EventEmitter();
  const calls = [];
  client.query = async (sql, args) => {
    calls.push({ sql, args });
    return { rows: sql.includes("INSERT INTO terminal_runtime_owners") ? [{ id: 7 }] : [] };
  };
  client.release = (destroy) => calls.push({ release: destroy });
  return { client, calls, db: { connect: async () => client, transaction: async (fn) => fn({ query: async () => ({ rows: [] }) }) } };
}

test("runtime acquires ownership before commit and destroys its lock connection after scoped shutdown", async () => {
  const { db, calls } = database();
  const runtime = await createTerminalRuntime(db, () => assert.fail("healthy owner lost"));
  assert.equal(runtime.ownerId, 7);
  assert.equal(runtime.active, true);
  assert.deepEqual(calls.slice(0, 4).map(c => c.sql.split(" ")[0]), ["BEGIN", "INSERT", "SELECT", "COMMIT"]);
  await runtime.stop();
  await runtime.stop();
  assert.equal(runtime.active, false);
  assert.equal(calls.filter(c => c.release).length, 1);
  const update = calls.find(c => c.sql?.includes("UPDATE terminal_sessions"));
  assert.match(update.sql, /WHERE runtime_owner_id=\$1/);
  assert.deepEqual(update.args, [7]);
});

test("lost database connection fails closed once and does not globally end sessions", async () => {
  const { db, client, calls } = database();
  let lost = 0;
  const runtime = await createTerminalRuntime(db, () => { lost++; });
  client.emit("error", new Error("connection lost"));
  client.emit("error", new Error("connection lost again"));
  assert.equal(lost, 1);
  assert.equal(runtime.active, false);
  await runtime.stop();
  assert.equal(calls.filter(c => c.release).length, 1);
  assert.equal(calls.some(c => c.sql?.includes("UPDATE terminal_sessions")), false);
});

test("reconciliation skips a live API lock and only closes the unlocked owner's sessions", async () => {
  const updates = [];
  const db = { transaction: async fn => fn({ query: async (sql, args) => {
    if (sql.startsWith("SELECT id")) return { rows: [{ id: 1 }, { id: 2 }] };
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: args[1] === 2 }] };
    updates.push({ sql, args });
    return { rowCount: 3 };
  } }) };
  assert.equal(await reconcileTerminalOwners(db), 3);
  assert.equal(updates.length, 2);
  assert.ok(updates.every(c => c.args[0] === 2));
  assert.match(updates[0].sql, /runtime_owner_id=\$1/);
});

test("failed startup destroys the lock connection and disables terminal runtime", async () => {
  const { db, client, calls } = database();
  client.query = async sql => { if (sql === "BEGIN") throw new Error("offline"); return { rows: [] }; };
  let lost = 0;
  await assert.rejects(createTerminalRuntime(db, () => { lost++; }), /offline/);
  assert.equal(lost, 1);
  assert.equal(calls.filter(c => c.release).length, 1);
});
