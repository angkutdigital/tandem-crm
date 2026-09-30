import { pool, WORKSPACE_ID } from "@/lib/db";
import { withTandemSession } from "tandem-crm/db";
import { DEFAULT_DEMO_USER_ID } from "@/lib/demo-users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A public, read-only Server-Sent Events feed of this deployment's own
 * event log -- built specifically for the live public demo (embedded
 * side-by-side with the dashboard on tandem-site), to make Tandem's core
 * pitch ("everything is a typed, append-only fact") visible in real time
 * instead of asserted in copy. Deliberately scoped to whatever single
 * workspace TANDEM_WORKSPACE_ID names (the same scoping every other route
 * in this app already has) -- there is no query parameter for a workspace
 * id, so this can never be pointed at a tenant other than the one this
 * deployment is already configured for.
 *
 * Polls (not LISTEN/NOTIFY) on purpose: this deployment's Postgres
 * connection is a plain pg.Pool over a serverless-friendly pooled
 * connection (Neon), which does not reliably hold a LISTEN session open
 * across a serverless function's lifecycle the way a long-running server
 * would. A short poll interval against each event log's own
 * identity-column `sequence` (a real, already-existing, strictly
 * increasing primary key -- see 002/008/011/014_*.sql) is simple, correct,
 * and cheap at this traffic level.
 *
 * Every query here goes through `withTandemSession`, exactly like every
 * other read in this app: RLS is enforced by the database, not by this
 * route trusting itself, and skipping that (querying `pool` directly)
 * silently returns zero rows forever rather than erroring -- the classic
 * "looks like it works, actually RLS never applied" trap this project's
 * own README calls out. Authenticated as the demo workspace's own fixed
 * owner id (`DEFAULT_DEMO_USER_ID`), the same identity the dashboard
 * itself defaults to -- this route shows exactly what that owner can see,
 * through the same RLS path a real signed-in request would use, not a
 * privilege bypass.
 */
type FeedRow = {
  source: "lead" | "onboarding" | "dispute" | "trail";
  sequence: number;
  type: string;
  occurredAt: string;
  /** Keys and value types of the payload. Never the values themselves. */
  shape: unknown;
};

const MAX_SHAPE_DEPTH = 4;
const MAX_SHAPE_KEYS = 30;

/**
 * Reduces a payload to its structure: objects keep their keys, every leaf
 * becomes its type name ("string", "number", "boolean", "null"), arrays
 * become a one-element list describing their first item. This demo is public
 * and strangers type into it, so a value must never leave this function;
 * only key names (which come from the app's own code) and type names do.
 */
function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 || depth >= MAX_SHAPE_DEPTH ? [] : [shapeOf(value[0], depth + 1)];
  }
  if (typeof value === "object") {
    if (depth >= MAX_SHAPE_DEPTH) return "object";
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).slice(0, MAX_SHAPE_KEYS)) {
      out[key.slice(0, 40)] = shapeOf((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return typeof value;
  return "unknown";
}

async function fetchNewRows(
  client: import("pg").PoolClient,
  table: string,
  source: FeedRow["source"],
  afterSequence: number
): Promise<{ rows: FeedRow[]; maxSequence: number }> {
  const result = await client.query<{ sequence: string; event_type: string; occurred_at: string; payload: unknown }>(
    `select sequence, event_type, occurred_at, payload from tandem.${table}
     where workspace_id = $1 and sequence > $2
     order by sequence limit 20`,
    [WORKSPACE_ID, afterSequence]
  );
  const rows = result.rows.map((r) => ({
    source, sequence: Number(r.sequence), type: r.event_type, occurredAt: new Date(r.occurred_at).toISOString(),
    shape: shapeOf(r.payload),
  }));
  const maxSequence = rows.length > 0 ? rows[rows.length - 1].sequence : afterSequence;
  return { rows, maxSequence };
}

export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const cursors = { events: 0, agent_events: 0, dispute_events: 0, trail_events: 0 };
  // Start from "now" (the latest existing sequence per table), not zero --
  // a visitor opening the demo should see what happens next, not replay
  // this workspace's entire history on every page load.
  await withTandemSession(pool, DEFAULT_DEMO_USER_ID, async (client) => {
    for (const table of ["events", "agent_events", "dispute_events", "trail_events"] as const) {
      const result = await client.query<{ max: string | null }>(
        `select max(sequence) as max from tandem.${table} where workspace_id = $1`,
        [WORKSPACE_ID]
      );
      cursors[table] = result.rows[0]?.max ? Number(result.rows[0].max) : 0;
    }
  });

  const stream = new ReadableStream({
    start(controller) {
      function send(row: FeedRow) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(row)}\n\n`));
      }
      async function poll() {
        if (closed) return;
        try {
          await withTandemSession(pool, DEFAULT_DEMO_USER_ID, async (client) => {
            const [events, onboarding, disputes, trail] = await Promise.all([
              fetchNewRows(client, "events", "lead", cursors.events),
              fetchNewRows(client, "agent_events", "onboarding", cursors.agent_events),
              fetchNewRows(client, "dispute_events", "dispute", cursors.dispute_events),
              fetchNewRows(client, "trail_events", "trail", cursors.trail_events),
            ]);
            cursors.events = events.maxSequence;
            cursors.agent_events = onboarding.maxSequence;
            cursors.dispute_events = disputes.maxSequence;
            cursors.trail_events = trail.maxSequence;
            const all = [...events.rows, ...onboarding.rows, ...disputes.rows, ...trail.rows]
              .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
            for (const row of all) send(row);
          });
        } catch {
          // A transient Postgres/network hiccup should not kill the stream;
          // the next poll tick just tries again from the same cursors.
        }
      }
      controller.enqueue(encoder.encode(": connected\n\n"));
      timer = setInterval(poll, 1500);
      request.signal.addEventListener("abort", () => {
        closed = true;
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting; nothing to do.
        }
      });
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Read-only event metadata (type, timestamp, and the payload's shape:
      // key names and value types, never values), for one fixed public demo workspace -- safe to serve
      // cross-origin so tandem-site's embed page can subscribe directly.
      "Access-Control-Allow-Origin": "*",
    },
  });
}
