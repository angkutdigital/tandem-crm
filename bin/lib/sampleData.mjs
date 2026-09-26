// Reusable sample-data seeder, generalized from
// examples/dashboard/scripts/seed.mjs's proven pattern (same event-log +
// replay + projection-write shape, just parameterized instead of reading
// env vars directly) so both `tandem-crm init --sample-data` and a hosted
// live-demo sandbox's reset job can share one source of truth instead of
// drifting copies. examples/dashboard/scripts/seed.mjs is intentionally
// left as its own richer demo dataset (6 leads, 4 agents) for local
// dashboard development -- this one is deliberately smaller, meant for a
// first quick look at the schema, not a full dashboard demo.
import { randomUUID } from "node:crypto";
import { replayLeadEvents } from "../../dist/index.js";

function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function leadEvent(workspaceId, leadId, type, data, occurredAt, sourceEventId) {
  return {
    id: randomUUID(), sequence: 0, workspaceId, leadId,
    source: "sample-data", sourceEventId, occurredAt, type, data,
  };
}

async function insertLead(client, workspaceId, { id, companyName, qualificationMetric, assigneeId, territoryId, events }) {
  let sequence = 1;
  for (const e of events) {
    await client.query(
      `insert into tandem.events
         (id, workspace_id, entity_type, entity_id, lead_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, 'lead', $3, $3, $4, $5, $6, $7, $8)`,
      [e.id, workspaceId, id, e.source, e.sourceEventId, e.type, JSON.stringify(e.data), e.occurredAt]
    );
    e.sequence = sequence++;
  }
  const state = replayLeadEvents(events, workspaceId, id);
  await client.query(
    `insert into tandem.leads
       (id, workspace_id, company_name, qualification_metric, pipeline_status, sales_stage, assignee_id, territory_id, last_event_sequence)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, workspaceId, companyName, qualificationMetric, state.status, state.salesStage, assigneeId, territoryId, state.lastSequence]
  );
  if (state.commission) {
    await client.query(
      `insert into tandem.payouts
         (id, workspace_id, lead_id, partner_id, amount_minor, currency, hold_days, payment_confirmed_at, release_at, status, last_event_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        state.commission.payoutId, workspaceId, id, state.commission.partnerId,
        state.commission.amountMinor, state.commission.currency, 30,
        state.payment.confirmedAt, state.commission.releaseAt, state.commission.status,
        events[events.length - 1].id,
      ]
    );
  }
}

/**
 * Seeds one small demo workspace: two territories, two agents, three leads
 * spanning Automated_Setup / Won-with-a-held-commission / a paid commission,
 * and one owner membership for `ownerUserId`. Runs in one transaction; the
 * whole thing rolls back on any failure. Refuses to run if `workspaceId`
 * already exists, matching Tandem's append-only design -- a caller that
 * wants a fresh demo passes a new id (or omits one and uses the returned
 * value).
 *
 * @param {import("pg").Pool} pool
 * @param {{ workspaceId?: string, ownerUserId?: string }} [options]
 * @returns {Promise<{ workspaceId: string }>}
 */
export async function seedSampleWorkspace(pool, options = {}) {
  const workspaceId = options.workspaceId ?? randomUUID();
  const ownerUserId = options.ownerUserId ?? randomUUID();
  const agentNorth = randomUUID();
  const agentSouth = randomUUID();
  const territoryNorth = randomUUID();
  const territorySouth = randomUUID();
  let eventCounter = 0;
  const nextSourceEventId = () => `sample-${++eventCounter}`;

  const client = await pool.connect();
  try {
    await client.query("begin");

    const existing = await client.query("select 1 from tandem.workspaces where id = $1", [workspaceId]);
    if ((existing.rowCount ?? 0) > 0) {
      throw new Error(`workspace ${workspaceId} already exists; pass a new workspaceId instead of reusing one`);
    }

    await client.query("insert into tandem.workspaces (id, slug) values ($1, $2)", [workspaceId, `sample-${workspaceId}`]);
    await client.query(
      `insert into tandem.territories (id, workspace_id, name, code) values ($1, $3, 'North', 'north'), ($2, $3, 'South', 'south')`,
      [territoryNorth, territorySouth, workspaceId]
    );
    await client.query(
      `insert into tandem.agents (id, workspace_id, display_name) values ($1, $3, 'Demo Agent North'), ($2, $3, 'Demo Agent South')`,
      [agentNorth, agentSouth, workspaceId]
    );
    await client.query(
      `insert into tandem.agent_territories (workspace_id, agent_id, territory_id) values ($1, $2, $3), ($1, $4, $5)`,
      [workspaceId, agentNorth, territoryNorth, agentSouth, territorySouth]
    );
    await client.query(
      `insert into tandem.members (workspace_id, user_id, role, agent_id) values
         ($1, $2, 'owner', null), ($1, $3, 'agent', $4), ($1, $5, 'agent', $6)`,
      [workspaceId, ownerUserId, randomUUID(), agentNorth, randomUUID(), agentSouth]
    );
    await client.query(
      `insert into tandem.commission_rules (workspace_id, product_tag, currency, basis_points, hold_days) values ($1, 'default', 'USD', 1000, 30)`,
      [workspaceId]
    );
    await client.query(`insert into tandem.waypoint_settings (workspace_id, strategy) values ($1, 'round_robin')`, [workspaceId]);

    const leadNew = randomUUID();
    await insertLead(client, workspaceId, {
      id: leadNew, companyName: "Sample Prospect Co", qualificationMetric: 8,
      assigneeId: agentNorth, territoryId: territoryNorth,
      events: [
        leadEvent(workspaceId, leadNew, "lead.created", { companyName: "Sample Prospect Co", qualificationMetric: 8, qualification: "Automated_Setup" }, daysAgo(2), nextSourceEventId()),
      ],
    });

    const leadHeld = randomUUID();
    const paidAt = daysAgo(15);
    const releaseAt = daysAgo(-15);
    await insertLead(client, workspaceId, {
      id: leadHeld, companyName: "Sample Fleet Partners", qualificationMetric: 14,
      assigneeId: agentSouth, territoryId: territorySouth,
      events: [
        leadEvent(workspaceId, leadHeld, "lead.created", { companyName: "Sample Fleet Partners", qualificationMetric: 14, qualification: "Manual_Review" }, daysAgo(25), nextSourceEventId()),
        leadEvent(workspaceId, leadHeld, "lead.assigned", { agentId: agentSouth, territoryId: territorySouth }, daysAgo(24), nextSourceEventId()),
        leadEvent(workspaceId, leadHeld, "conversion.confirmed", {}, daysAgo(20), nextSourceEventId()),
        leadEvent(workspaceId, leadHeld, "payment.confirmed", { amountMinor: 250_000, currency: "USD" }, paidAt, nextSourceEventId()),
        leadEvent(workspaceId, leadHeld, "commission.held", { payoutId: randomUUID(), partnerId: "sample-partner", amountMinor: 25_000, currency: "USD", releaseAt }, paidAt, nextSourceEventId()),
      ],
    });

    const leadPaid = randomUUID();
    const paidPayoutId = randomUUID();
    const paidAt2 = daysAgo(60);
    const releaseAt2 = daysAgo(30);
    await insertLead(client, workspaceId, {
      id: leadPaid, companyName: "Sample Logistics Group", qualificationMetric: 40,
      assigneeId: agentNorth, territoryId: territoryNorth,
      events: [
        leadEvent(workspaceId, leadPaid, "lead.created", { companyName: "Sample Logistics Group", qualificationMetric: 40, qualification: "Manual_Review" }, daysAgo(80), nextSourceEventId()),
        leadEvent(workspaceId, leadPaid, "lead.assigned", { agentId: agentNorth, territoryId: territoryNorth }, daysAgo(79), nextSourceEventId()),
        leadEvent(workspaceId, leadPaid, "conversion.confirmed", {}, daysAgo(70), nextSourceEventId()),
        leadEvent(workspaceId, leadPaid, "payment.confirmed", { amountMinor: 600_000, currency: "USD" }, paidAt2, nextSourceEventId()),
        leadEvent(workspaceId, leadPaid, "commission.held", { payoutId: paidPayoutId, partnerId: "sample-partner", amountMinor: 60_000, currency: "USD", releaseAt: releaseAt2 }, paidAt2, nextSourceEventId()),
        leadEvent(workspaceId, leadPaid, "commission.eligible", { payoutId: paidPayoutId }, releaseAt2, nextSourceEventId()),
        leadEvent(workspaceId, leadPaid, "commission.approved", { payoutId: paidPayoutId }, releaseAt2, nextSourceEventId()),
        leadEvent(workspaceId, leadPaid, "commission.paid", { payoutId: paidPayoutId, payoutReference: "sample-payrun-1" }, releaseAt2, nextSourceEventId()),
      ],
    });

    await client.query("commit");
    return { workspaceId };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// Every append-only log (tandem.events, tandem.payout_ledger,
// tandem.agent_events, tandem.dispute_events, tandem.trail_events) has a
// trigger that unconditionally rejects UPDATE/DELETE -- see 002_tandem_events.sql's
// reject_event_mutation(). That is exactly the right behavior for every
// real workspace, and it means a naive `delete from tandem.events` here
// would fail immediately. Disabling the trigger for the duration of this
// one transaction (only possible for the table owner, which an elevated
// seed/reset connection is, never the `authenticated` app role) is the
// standard, narrow way to do a real deletion of disposable data without
// weakening the append-only guarantee for anyone else.
const immutableLogTriggers = [
  ["events", "tandem_events_immutable"],
  ["payout_ledger", "tandem_payout_ledger_immutable"],
  ["agent_events", "tandem_agent_events_immutable"],
  ["dispute_events", "tandem_dispute_events_immutable"],
  ["trail_events", "tandem_trail_events_immutable"],
];

/**
 * Deletes one workspace's rows entirely -- a deliberate, narrow exception
 * to Tandem's append-only design, meant ONLY for disposable sample/demo
 * workspaces (a live-demo sandbox's reset job, a throwaway local install
 * check). Never call this against a workspace holding real business
 * history: every other part of this package treats deleting event history
 * as a design violation, not a feature, on purpose. Requires a connection
 * that owns these tables (the same elevated connection seeding already
 * needs); the ordinary `authenticated` app role has no ALTER TABLE
 * privilege and cannot reach this path.
 *
 * @param {import("pg").Pool} pool
 * @param {string} workspaceId
 */
export async function wipeSampleWorkspace(pool, workspaceId) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const [table, trigger] of immutableLogTriggers) {
      await client.query(`alter table tandem.${table} disable trigger ${trigger}`);
    }
    // Dependency order matters here in a way it never has to for the rest
    // of this package: tandem.members' (workspace_id, agent_id) foreign key
    // is `on delete set null`, which nulls BOTH composite columns --
    // including workspace_id, which is NOT NULL on members. Deleting
    // members before agents avoids ever triggering that action. leads must
    // go before agents/territories too (assignee_id/territory_id are `on
    // delete restrict`), and everything referencing leads/agents must go
    // before leads/agents themselves.
    for (const table of [
      "payout_ledger", "payouts", "dispute_events", "disputes",
      "trail_events", "trail_entries", "agent_events", "agent_onboarding_status",
      "events", "leads", "members", "agent_territories", "onboarding_steps",
      "commission_rules", "waypoint_settings", "agents", "territories",
    ]) {
      await client.query(`delete from tandem.${table} where workspace_id = $1`, [workspaceId]);
    }
    // tandem.workspaces is the one table here keyed by "id", not "workspace_id".
    await client.query(`delete from tandem.workspaces where id = $1`, [workspaceId]);
    for (const [table, trigger] of immutableLogTriggers) {
      await client.query(`alter table tandem.${table} enable trigger ${trigger}`);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
