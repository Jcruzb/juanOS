import pg from "pg";

const { Pool } = pg;

export function createDatabase(connectionString) {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000
  });

  return {
    connect() { return pool.connect(); },
    query(text, values) {
      return pool.query(text, values);
    },
    async transaction(callback) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await callback({ query: (text, values) => client.query(text, values) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close() {
      return pool.end();
    }
  };
}
