import { Pool, type PoolClient } from "pg";

/**
 * Creates a Postgres pool for a Tandem deployment. Tandem keeps no connection
 * state of its own, so a single pool per process is sufficient.
 */
export function createTandemPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

/**
 * Runs `fn` inside a transaction with the caller's identity published as
 * `tandem.user_id`, which the SQL helpers read via
 * `current_setting('tandem.user_id', true)`.
 *
 * The value is written with `set_config(..., true)`, which scopes it to the
 * current transaction. That matters on a pooled connection: a session-level
 * setting would survive the commit and leak one caller's identity into the
 * next caller who borrows that connection.
 *
 * Pass `userId = null` for anonymous or system work (background jobs, admin
 * scripts); no setting is written and the helpers resolve to null.
 */
export async function withTandemSession<T>(
  pool: Pool,
  userId: string | null,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (userId !== null) {
      await client.query("select set_config('tandem.user_id', $1, true)", [userId]);
    }
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
