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
 * The transaction also assumes the `authenticated` role via `set local
 * role`, unconditionally. This matters even more than the identity setting:
 * RLS is bypassed entirely for a table's owner and for a superuser, and the
 * role a hosted Postgres (Neon, RDS, a fresh Supabase project) gives you by
 * default is almost always exactly that owner role. Without this, a caller
 * using this function precisely as documented gets zero row-level security
 * -- every policy this schema defines would silently do nothing, and it
 * would look identical to it working, since a query with no matching rows
 * and a query that never applied a policy at all can return the same
 * result. The connecting role must have `authenticated` granted to it once
 * (`grant authenticated to <your_connection_role>;`) for this to succeed; if
 * that grant is missing, `set local role` fails loudly with a permission
 * error rather than silently skipping enforcement.
 *
 * Pass `userId = null` for anonymous or system work (background jobs, admin
 * scripts); no `tandem.user_id` is set and the identity helpers resolve to
 * null, so RLS still applies (as `authenticated` with no matching rows)
 * rather than being bypassed.
 */
export async function withTandemSession<T>(
  pool: Pool,
  userId: string | null,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
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
