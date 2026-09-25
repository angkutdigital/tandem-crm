#!/usr/bin/env node
// Automated cross-tenant RLS check, run against a real Postgres instance in
// CI. This project has shipped RLS bugs before that a query with no rows and
// a query with no policy applied at all look identical (see CHANGELOG.md);
// the whole point of this script is that nobody has to re-verify that by
// hand against a disposable database ever again.
import { randomUUID } from "node:crypto";
import { createTandemPool, applyTandemMigrations, withTandemSession } from "../dist/db/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = createTandemPool(databaseUrl);
let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`ok - ${name}`);
  } else {
    console.error(`NOT OK - ${name}`);
    failures++;
  }
}

async function main() {
  const { applied } = await applyTandemMigrations(pool);
  console.log(`applied ${applied.length} migration(s): ${applied.join(", ") || "(already up to date)"}`);

  // The CI role owns everything it just created, so it needs the same
  // one-time grant the README asks a real deployment to run.
  const { rows: [{ role: connectionRole }] } = await pool.query("select current_user as role");
  await pool.query(`grant authenticated to "${connectionRole}"`);

  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const agentA = randomUUID();
  const agentB = randomUUID();
  const leadA = randomUUID();
  const leadB = randomUUID();

  await pool.query("begin");
  try {
    await pool.query(
      "insert into tandem.workspaces (id, slug) values ($1, 'ci-workspace-a'), ($2, 'ci-workspace-b')",
      [workspaceA, workspaceB]
    );
    await pool.query(
      "insert into tandem.agents (id, workspace_id, display_name) values ($1, $2, 'CI Agent A'), ($3, $4, 'CI Agent B')",
      [agentA, workspaceA, agentB, workspaceB]
    );
    await pool.query(
      "insert into tandem.members (workspace_id, user_id, role, agent_id) values ($1, $2, 'owner', null), ($3, $4, 'owner', null)",
      [workspaceA, userA, workspaceB, userB]
    );
    await pool.query(
      `insert into tandem.leads (id, workspace_id, company_name, qualification_metric, pipeline_status, assignee_id)
       values ($1, $2, 'CI Lead A', 1, 'Won', $3), ($4, $5, 'CI Lead B', 1, 'Won', $6)`,
      [leadA, workspaceA, agentA, leadB, workspaceB, agentB]
    );
    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback");
    throw error;
  }

  const membersAsA = await withTandemSession(pool, userA, (client) =>
    client.query("select workspace_id from tandem.members")
  );
  check(
    "user A sees only workspace A's members",
    membersAsA.rows.length === 1 && membersAsA.rows[0].workspace_id === workspaceA
  );

  const leadsAsA = await withTandemSession(pool, userA, (client) => client.query("select id from tandem.leads"));
  check("user A sees only workspace A's leads", leadsAsA.rows.length === 1 && leadsAsA.rows[0].id === leadA);

  const leadsAsB = await withTandemSession(pool, userB, (client) => client.query("select id from tandem.leads"));
  check("user B sees only workspace B's leads", leadsAsB.rows.length === 1 && leadsAsB.rows[0].id === leadB);

  // Not "user A gets fewer rows"; user A asking BY ID for workspace B's own
  // lead must come back empty, not an error and not the row.
  const crossTenantRead = await withTandemSession(pool, userA, (client) =>
    client.query("select id from tandem.leads where id = $1", [leadB])
  );
  check("user A's direct query for workspace B's lead returns zero rows", crossTenantRead.rows.length === 0);

  // A query with no identity set and a query with RLS silently not applied
  // return the same shape of result unless this is checked: this is exactly
  // the bug withTandemSession shipped once (see CHANGELOG.md's Fixed
  // section). No identity must mean zero rows, not every row.
  const leadsAsNobody = await withTandemSession(pool, null, (client) => client.query("select id from tandem.leads"));
  check("no identity sees zero leads (RLS is enforced, not bypassed)", leadsAsNobody.rows.length === 0);

  const stranger = randomUUID();
  const leadsAsStranger = await withTandemSession(pool, stranger, (client) =>
    client.query("select id from tandem.leads")
  );
  check("a user with no membership anywhere sees zero leads", leadsAsStranger.rows.length === 0);

  await pool.end();

  if (failures > 0) {
    console.error(`\n${failures} RLS check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll RLS checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
