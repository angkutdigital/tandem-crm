import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const migrationsDirectory = fileURLToPath(
  new URL("../../db/migrations", import.meta.url)
);

const supersedesDirective = /^--\s*tandem:supersedes\s+(.+)$/m;

/**
 * Applies any pending SQL migrations shipped in `db/migrations` to the
 * database behind `pool`.
 *
 * A `tandem.schema_migrations` table records which migration filenames have
 * already run. That is what makes this function idempotent: on every call we
 * compare the files on disk with the rows in that table and only apply the
 * missing ones, so it is safe to run on deploy or startup.
 *
 * Each file is read and sent to Postgres as one un-split query inside its own
 * transaction. Running the whole file in one call is necessary because these
 * migrations contain dollar-quoted `do $$ ... $$` blocks with embedded
 * semicolons; splitting on `;` would break them. One transaction per file
 * means a migration either lands completely or rolls back completely, and the
 * tracking row is inserted before the commit so a file is never recorded as
 * applied unless it actually succeeded.
 *
 * A migration can declare `-- tandem:supersedes a.sql b.sql` when it fully
 * re-does older files that cannot run on every host (005 and 006 assume
 * Supabase; 007 replaces both). Superseded files are never run, so a fresh
 * install goes straight to the portable version, while a database that
 * already applied the old files keeps its history untouched.
 *
 * Returns the filenames that were applied in this call, in sorted order. The
 * array is empty when there was nothing new to apply.
 */
export async function applyTandemMigrations(
  pool: Pool
): Promise<{ applied: string[] }> {
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  const sources = new Map<string, string>();
  const superseded = new Set<string>();
  for (const filename of filenames) {
    const sql = await readFile(join(migrationsDirectory, filename), "utf8");
    sources.set(filename, sql);
    const directive = sql.match(supersedesDirective);
    if (directive) {
      for (const name of directive[1].trim().split(/\s+/)) superseded.add(name);
    }
  }

  const client = await pool.connect();
  try {
    await client.query("create schema if not exists tandem");
    const tracking = await client.query<{ exists: boolean }>(
      "select to_regclass('tandem.schema_migrations') is not null as exists"
    );
    if (!tracking.rows[0].exists) {
      const legacy = await client.query<{ exists: boolean }>(
        "select to_regclass('tandem.workspaces') is not null as exists"
      );
      if (legacy.rows[0].exists) {
        throw new Error(
          "tandem schema exists but was not created by applyTandemMigrations; " +
            "record the migrations it already has in tandem.schema_migrations " +
            "first (see README, \"Upgrading a hand-migrated database\")"
        );
      }
      await client.query(
        "create table tandem.schema_migrations (filename text primary key, applied_at timestamptz not null default now())"
      );
    }

    const appliedRows = await client.query<{ filename: string }>(
      "select filename from tandem.schema_migrations"
    );
    const alreadyApplied = new Set(appliedRows.rows.map((row) => row.filename));

    const applied: string[] = [];
    for (const filename of filenames) {
      if (alreadyApplied.has(filename) || superseded.has(filename)) continue;

      try {
        await client.query("begin");
        await client.query(sources.get(filename)!);
        await client.query(
          "insert into tandem.schema_migrations (filename) values ($1)",
          [filename]
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }

      applied.push(filename);
    }

    return { applied };
  } finally {
    client.release();
  }
}
