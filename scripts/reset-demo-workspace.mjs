#!/usr/bin/env node
// Internal tooling for TandemCRM's own public live-demo deployment, not
// part of the published npm package (this file lives under scripts/, which
// package.json's "files" field does not include -- same as
// scripts/ci-rls-check.mjs). Resets one fixed demo workspace: wipes it (see
// bin/lib/sampleData.mjs's wipeSampleWorkspace -- a deliberate, narrow
// exception to Tandem's append-only design, safe only because this
// workspace never holds real business history) and reseeds it with the
// exact fixed demo personas examples/dashboard/scripts/seed.mjs's identity
// switcher expects (components/user-switcher.tsx hardcodes those five user
// ids), so a live public demo's data doesn't accumulate what visitors
// clicked through or drift into a broken state over time.
//
// Meant to run on a schedule (a cron job, a scheduled serverless function)
// against the database backing the publicly reachable examples/dashboard
// deployment. Requires an elevated connection (the same credential level
// bin/tandem-crm.mjs and examples/dashboard/scripts/seed.mjs already need),
// and a fixed DEMO_WORKSPACE_ID matching that deployment's own
// TANDEM_WORKSPACE_ID so the reset never changes what URL visitors land on.
//
// Usage:
//   DATABASE_URL=... DEMO_WORKSPACE_ID=... node scripts/reset-demo-workspace.mjs
import { createTandemPool } from "../dist/db/index.js";
import { wipeSampleWorkspace } from "../bin/lib/sampleData.mjs";
import { seedDemoWorkspace } from "../examples/dashboard/scripts/seed.mjs";

const databaseUrl = process.env.DATABASE_URL;
const workspaceId = process.env.DEMO_WORKSPACE_ID;

if (!databaseUrl || !workspaceId) {
  console.error("DATABASE_URL and DEMO_WORKSPACE_ID are both required.");
  process.exit(1);
}

const pool = createTandemPool(databaseUrl);
try {
  console.log(`Resetting public demo workspace ${workspaceId}...`);
  await wipeSampleWorkspace(pool, workspaceId);
  await seedDemoWorkspace(pool, workspaceId);
  console.log("Reset complete.");
} finally {
  await pool.end();
}
