#!/usr/bin/env node
// The generic, self-serve install path: DATABASE_URL -> migrations ->
// health check -> first workspace/admin bootstrap (or a sample/demo
// workspace instead), the "last mile" HANDOFF.md named after Nest
// configuration was completed. Deliberately plain .mjs against the built
// dist/, not a second TypeScript entry point -- same convention
// scripts/ci-rls-check.mjs already uses.
import { randomUUID } from "node:crypto";
import { createTandemPool, applyTandemMigrations } from "../dist/db/index.js";
import { runHealthCheck } from "./lib/healthCheck.mjs";
import { seedSampleWorkspace } from "./lib/sampleData.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function printUsage() {
  console.log(`Usage: tandem-crm init [options]

Applies Tandem's migrations to DATABASE_URL, grants the connecting role
"authenticated" (required for row-level security to apply at all -- see
README's "Database setup"), runs a health check, and optionally bootstraps
a first workspace.

Options:
  --database-url <url>     Postgres connection string (default: $DATABASE_URL)
  --skip-grant              Do not grant "authenticated" to the connecting role
  --admin-user-id <uuid>    Create a first, empty workspace owned by this user id
                            (an id from your own auth system -- Tandem never
                            creates auth users itself, see TandemAdminAdapter)
  --workspace-slug <slug>   Slug for that workspace (default: "default")
  --sample-data              Instead of an empty workspace, seed a small demo
                              workspace (agents, leads across the pipeline, a
                              held and a paid commission) so you have something
                              to look at immediately
  -h, --help                 Show this message
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (args.h || args.help || !command) {
    printUsage();
    process.exit(command ? 0 : 1);
  }
  if (command !== "init") {
    console.error(`Unknown command "${command}". Only "init" is supported today.`);
    printUsage();
    process.exit(1);
  }

  const databaseUrl = typeof args["database-url"] === "string" ? args["database-url"] : process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("A database connection string is required: pass --database-url or set DATABASE_URL.");
    process.exit(1);
  }
  if (args["sample-data"] && typeof args["admin-user-id"] === "string") {
    console.error("Pass either --sample-data or --admin-user-id, not both: a sample workspace already has its own demo membership.");
    process.exit(1);
  }

  const pool = createTandemPool(databaseUrl);
  try {
    console.log("Applying migrations...");
    const { applied } = await applyTandemMigrations(pool);
    console.log(applied.length > 0 ? `  applied ${applied.length}: ${applied.join(", ")}` : "  already up to date");

    if (!args["skip-grant"]) {
      const { rows: [{ role }] } = await pool.query("select current_user as role");
      await pool.query(`grant authenticated to "${role}"`);
      console.log(`Granted "authenticated" to "${role}".`);
    } else {
      console.log("Skipped granting \"authenticated\" (--skip-grant) -- do this yourself or RLS will silently block every query.");
    }

    console.log("\nHealth check:");
    const results = await runHealthCheck(pool);
    let allPassed = true;
    for (const result of results) {
      console.log(`  ${result.passed ? "ok" : "FAIL"} - ${result.name}: ${result.detail}`);
      if (!result.passed) allPassed = false;
    }
    if (!allPassed) {
      console.error("\nOne or more health checks failed. Resolve the failures above before continuing.");
      process.exit(1);
    }

    if (args["sample-data"]) {
      console.log("\nSeeding a sample workspace...");
      const { workspaceId } = await seedSampleWorkspace(pool);
      console.log(`  done. TANDEM_WORKSPACE_ID=${workspaceId}`);
    } else if (typeof args["admin-user-id"] === "string") {
      const workspaceId = randomUUID();
      const slug = typeof args["workspace-slug"] === "string" ? args["workspace-slug"] : "default";
      console.log(`\nBootstrapping workspace "${slug}"...`);
      await pool.query("insert into tandem.workspaces (id, slug) values ($1, $2)", [workspaceId, slug]);
      await pool.query(
        "insert into tandem.members (workspace_id, user_id, role, agent_id) values ($1, $2, 'owner', null)",
        [workspaceId, args["admin-user-id"]]
      );
      console.log(`  done. TANDEM_WORKSPACE_ID=${workspaceId}`);
    } else {
      console.log("\nNo --sample-data or --admin-user-id passed: schema is ready, but no workspace was created.");
    }

    console.log("\ntandem-crm init complete.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
