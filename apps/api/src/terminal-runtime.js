// One session-level PostgreSQL lock per API process. Never infer ownership from age.
const LOCK_NAMESPACE = 1247104596;

export async function reconcileTerminalOwners(db) {
  return db.transaction(async (tx) => {
    const owners = await tx.query("SELECT id FROM terminal_runtime_owners WHERE ended_at IS NULL ORDER BY id");
    let ended = 0;
    for (const { id } of owners.rows) {
      const lock = await tx.query("SELECT pg_try_advisory_xact_lock($1, $2) AS acquired", [LOCK_NAMESPACE, id]);
      if (!lock.rows[0].acquired) continue;
      const result = await tx.query(`UPDATE terminal_sessions SET status='ended', ended_at=COALESCE(ended_at,now())
        WHERE runtime_owner_id=$1 AND status='active'`, [id]);
      ended += result.rowCount;
      await tx.query("UPDATE terminal_runtime_owners SET ended_at=now() WHERE id=$1 AND ended_at IS NULL", [id]);
    }
    return ended;
  });
}

export async function createTerminalRuntime(db, onLost) {
  const client = await db.connect();
  let ownerId;
  let stopped = false;
  let timer;
  const lost = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try { onLost(); } finally { client.release(true); }
  };
  client.on("error", lost);
  try {
    // Owner is invisible to reconcilers until its lifetime lock has been acquired.
    await client.query("BEGIN");
    const created = await client.query("INSERT INTO terminal_runtime_owners DEFAULT VALUES RETURNING id");
    ownerId = created.rows[0].id;
    await client.query("SELECT pg_advisory_lock($1,$2)", [LOCK_NAMESPACE, ownerId]);
    await client.query("COMMIT");
    await reconcileTerminalOwners(db);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    lost();
    throw error;
  }
  let checking = false;
  timer = setInterval(() => {
    if (checking || stopped) return;
    checking = true;
    void client.query("SELECT 1")
      .then(() => reconcileTerminalOwners(db))
      .catch(lost)
      .finally(() => { checking = false; });
  }, 10_000);
  timer.unref();
  return {
    ownerId,
    get active() { return !stopped; },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        await client.query(`UPDATE terminal_sessions SET status='ended',ended_at=COALESCE(ended_at,now())
          WHERE runtime_owner_id=$1 AND status='active'`, [ownerId]);
        await client.query("UPDATE terminal_runtime_owners SET ended_at=now() WHERE id=$1", [ownerId]);
      } finally {
        // Destroy, rather than pool, the connection holding a session-level lock.
        client.release(true);
      }
    }
  };
}
