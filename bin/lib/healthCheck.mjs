// Generic Postgres health check for a Tandem installation -- deliberately
// not Supabase-specific, unlike src/doctor.ts (which checks PostgREST
// exposure, a Supabase-only concern). This checks the one thing that is
// universal and the one thing this project has shipped a real bug around
// before (see CHANGELOG.md, and client.ts's own comment): whether the
// connecting role actually has RLS enforcement wired up, not just whether
// the schema exists.

const coreTables = ["workspaces", "members", "leads", "events", "payouts"];

/** @param {import("pg").Pool} pool */
export async function runHealthCheck(pool) {
  const results = [];
  const client = await pool.connect();
  try {
    const migrations = await client.query(
      "select to_regclass('tandem.schema_migrations') is not null as exists"
    );
    if (!migrations.rows[0].exists) {
      results.push({
        name: "migrations applied",
        passed: false,
        detail: "tandem.schema_migrations does not exist -- migrations have not run against this database yet.",
      });
      return results;
    }
    const appliedCount = await client.query("select count(*)::int as n from tandem.schema_migrations");
    results.push({
      name: "migrations applied",
      passed: appliedCount.rows[0].n > 0,
      detail: `${appliedCount.rows[0].n} migration(s) recorded as applied.`,
    });

    const roleExists = await client.query(
      "select exists (select 1 from pg_roles where rolname = 'authenticated') as exists"
    );
    results.push({
      name: "authenticated role exists",
      passed: roleExists.rows[0].exists,
      detail: roleExists.rows[0].exists
        ? "The `authenticated` role exists."
        : "The `authenticated` role is missing -- migration 007 should have created it. Re-run migrations.",
    });

    const currentRole = await client.query("select current_user as role");
    const hasGrant = await client.query(
      "select pg_has_role($1, 'authenticated', 'member') as granted",
      [currentRole.rows[0].role]
    );
    results.push({
      name: "connecting role can assume authenticated",
      passed: hasGrant.rows[0].granted,
      detail: hasGrant.rows[0].granted
        ? `"${currentRole.rows[0].role}" can assume the authenticated role (RLS will actually apply).`
        : `"${currentRole.rows[0].role}" cannot assume authenticated -- every RLS policy will silently do nothing until you run: grant authenticated to "${currentRole.rows[0].role}";`,
    });

    const rls = await client.query(
      `select c.relname as table, c.relrowsecurity as enabled
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'tandem' and c.relname = any($1)`,
      [coreTables]
    );
    const byTable = new Map(rls.rows.map((r) => [r.table, r.enabled]));
    for (const table of coreTables) {
      const enabled = byTable.get(table);
      results.push({
        name: `RLS enabled on tandem.${table}`,
        passed: enabled === true,
        detail:
          enabled === true
            ? `Row-level security is enabled on tandem.${table}.`
            : enabled === false
              ? `Row-level security is NOT enabled on tandem.${table}. This should not happen after a clean migration run -- do not deploy against this database until resolved.`
              : `tandem.${table} was not found -- migrations may not have completed.`,
      });
    }

    return results;
  } finally {
    client.release();
  }
}
