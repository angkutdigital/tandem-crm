#!/usr/bin/env node
// Resets the public live demo: deletes everything visitors typed into the demo
// workspace and reseeds the same fixed personas the dashboard's identity
// switcher expects, so the demo looks like it did on day one.
//
// This DELETES append-only history on purpose, which is exactly what the rest
// of Tandem refuses to do. It is only safe because the demo workspace is
// disposable, so it has guards:
//   - the workspace must exist and its slug must start with "demo-"
//   - you must pass --confirm <workspaceId> matching the id you are wiping
//   - --dry-run reports what would be deleted and changes nothing
//
// Run: DATABASE_URL=... TANDEM_WORKSPACE_ID=... \
//      node scripts/reset-demo-workspace.mjs --confirm "$TANDEM_WORKSPACE_ID"
import { createTandemPool } from "../dist/db/index.js";
import { wipeSampleWorkspace } from "../bin/lib/sampleData.mjs";
import { seedDemoWorkspace, DEMO_USER_IDS } from "../examples/dashboard/scripts/seed.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const confirmIndex = args.indexOf("--confirm");
const confirmed = confirmIndex >= 0 ? args[confirmIndex + 1] : undefined;

const databaseUrl = process.env.DATABASE_URL;
const workspaceId = process.env.TANDEM_WORKSPACE_ID;
if (!databaseUrl || !workspaceId) {
  console.error("DATABASE_URL and TANDEM_WORKSPACE_ID are required.");
  process.exit(1);
}
if (!dryRun && confirmed !== workspaceId) {
  console.error(`Refusing to run: pass --confirm ${workspaceId} to wipe this workspace (or --dry-run to preview).`);
  process.exit(1);
}

const pool = createTandemPool(databaseUrl);

async function counts() {
  const { rows } = await pool.query(
    `select
       (select count(*) from tandem.leads where workspace_id = $1) as leads,
       (select count(*) from tandem.events where workspace_id = $1) as events,
       (select count(*) from tandem.agents where workspace_id = $1) as agents,
       (select count(*) from tandem.payouts where workspace_id = $1) as payouts`,
    [workspaceId]
  );
  return rows[0];
}

try {
  const { rows } = await pool.query("select slug from tandem.workspaces where id = $1", [workspaceId]);
  if (rows.length === 0) {
    console.error(`Workspace ${workspaceId} does not exist, nothing to reset.`);
    process.exit(1);
  }
  if (!String(rows[0].slug).startsWith("demo-")) {
    console.error(`Refusing to wipe workspace "${rows[0].slug}": only workspaces whose slug starts with "demo-" can be reset.`);
    process.exit(1);
  }

  console.log("before:", await counts());
  if (dryRun) {
    console.log("--dry-run: nothing changed.");
  } else {
    await wipeSampleWorkspace(pool, workspaceId);
    await seedDemoWorkspace(pool, workspaceId);
    const after = await counts();
    console.log("after: ", after);

    const { rows: members } = await pool.query(
      "select user_id from tandem.members where workspace_id = $1",
      [workspaceId]
    );
    const expected = Object.values(DEMO_USER_IDS);
    const missing = expected.filter((id) => !members.some((m) => m.user_id === id));
    if (missing.length > 0) {
      console.error(`Reset finished but these demo personas are missing: ${missing.join(", ")}`);
      process.exit(1);
    }
    console.log(`Reset complete: workspace ${workspaceId} reseeded with ${expected.length} demo personas.`);
  }
} finally {
  await pool.end();
}
