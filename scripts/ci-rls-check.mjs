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
  // A non-admin identity in workspace A, linked to agentA. Migration 013's
  // payouts UPDATE / payout_ledger INSERT policies are admin-only with no
  // "assignee_id = current_agent_id" branch, so this identity exists purely
  // to prove an agent cannot approve/pay out their own commission.
  const agentUserA = randomUUID();
  const payoutA = randomUUID();
  const payoutEventA = randomUUID();
  const overdueDisputeA = randomUUID();
  const policyDisputeA = randomUUID();
  const adminCreatedLeadA = randomUUID();
  const adminCreateEventA = randomUUID();
  const agentCreatedLeadA = randomUUID();
  const onboardingStepA = randomUUID();
  const trailEntryA = randomUUID();
  const adminCreatedAgentA = randomUUID();

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
      "insert into tandem.members (workspace_id, user_id, role, agent_id) values ($1, $2, 'owner', null), ($3, $4, 'owner', null), ($5, $6, 'agent', $7)",
      [workspaceA, userA, workspaceB, userB, workspaceA, agentUserA, agentA]
    );
    await pool.query(
      `insert into tandem.agent_onboarding_status (workspace_id, agent_id)
       values ($1, $2), ($3, $4)`,
      [workspaceA, agentA, workspaceB, agentB]
    );
    await pool.query(
      `insert into tandem.leads (id, workspace_id, company_name, qualification_metric, pipeline_status, assignee_id)
       values ($1, $2, 'CI Lead A', 1, 'Won', $3), ($4, $5, 'CI Lead B', 1, 'Won', $6)`,
      [leadA, workspaceA, agentA, leadB, workspaceB, agentB]
    );
    // payouts.last_event_id is a NOT NULL FK into tandem.events(workspace_id, id),
    // so the event has to exist before the payout can reference it.
    await pool.query(
      `insert into tandem.events
         (id, workspace_id, entity_type, entity_id, lead_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, 'payout', $3, $4, 'ci', 'ci-payout-held-a', 'commission.held', $5, now())`,
      [payoutEventA, workspaceA, payoutA, leadA, JSON.stringify({ payoutId: payoutA })]
    );
    await pool.query(
      `insert into tandem.payouts
         (id, workspace_id, lead_id, partner_id, amount_minor, currency, hold_days,
          payment_confirmed_at, release_at, status, last_event_id)
       values ($1, $2, $3, 'ci-partner', 1000, 'USD', 0, now(), now(), 'held', $4)`,
      [payoutA, workspaceA, leadA, payoutEventA]
    );
    await pool.query(
      `insert into tandem.disputes
         (id, workspace_id, lead_id, payout_id, opened_by_agent_id, category,
          expected_amount_minor, description, status, opened_at, auto_approve_at)
       values ($1, $2, $3, $4, $5, 'incorrect', 1200, 'CI overdue dispute',
               'open', now() - interval '2 days', now() - interval '1 day')`,
      [overdueDisputeA, workspaceA, leadA, payoutA, agentA]
    );
    // This second, still-open projection exists solely to exercise Coaster's
    // interactive RLS boundary below. The overdue dispute is intentionally
    // consumed by the scheduler test, so it cannot also model an open case.
    await pool.query(
      `insert into tandem.disputes
         (id, workspace_id, lead_id, payout_id, opened_by_agent_id, category,
          expected_amount_minor, description, status, opened_at, auto_approve_at)
       values ($1, $2, $3, $4, $5, 'untracked', null, 'CI policy dispute',
               'open', now(), now() + interval '30 days')`,
      [policyDisputeA, workspaceA, leadA, payoutA, agentA]
    );
    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback");
    throw error;
  }

  // 015 keeps scheduling vendor-neutral: CI invokes the database function
  // directly, while a production host calls the same function from its own
  // trusted scheduler. It must resolve exactly once and write one immutable
  // event, even when the scheduler is retried.
  const firstOverdueRun = await pool.query(
    "select dispute_id from tandem.resolve_overdue_disputes()"
  );
  check(
    "overdue-dispute scheduler resolves the due dispute",
    firstOverdueRun.rows.length === 1 && firstOverdueRun.rows[0].dispute_id === overdueDisputeA
  );
  const secondOverdueRun = await pool.query(
    "select dispute_id from tandem.resolve_overdue_disputes()"
  );
  check("overdue-dispute scheduler is idempotent on retry", secondOverdueRun.rows.length === 0);
  const overdueResolution = await pool.query(
    `select d.status, d.outcome, count(e.id) as event_count
     from tandem.disputes d
     left join tandem.dispute_events e on e.dispute_id = d.id
     where d.id = $1
     group by d.status, d.outcome`,
    [overdueDisputeA]
  );
  check(
    "overdue dispute projection and immutable event agree",
    overdueResolution.rows.length === 1 &&
      overdueResolution.rows[0].status === "resolved" &&
      overdueResolution.rows[0].outcome === "upheld" &&
      Number(overdueResolution.rows[0].event_count) === 1
  );

  const membersAsA = await withTandemSession(pool, userA, (client) =>
    client.query("select workspace_id from tandem.members")
  );
  check(
    "user A sees only workspace A's members",
    // Two rows now that agentUserA also belongs to workspace A (the owner
    // row and the agent row), but every one of them must be workspace A's.
    membersAsA.rows.length === 2 && membersAsA.rows.every((row) => row.workspace_id === workspaceA)
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

  // Core creation is an event plus a projection in one transaction. This
  // verifies migration 016's narrow admin-only INSERT permission, which the
  // reference dashboard uses for its New lead flow.
  const adminCreatedLead = await withTandemSession(pool, userA, async (client) => {
    const event = await client.query(
      `insert into tandem.events
         (id, workspace_id, entity_type, entity_id, lead_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, 'lead', $3, $3, 'ci', 'ci-admin-lead-created', 'lead.created', $4, now())
       returning sequence`,
      [adminCreateEventA, workspaceA, adminCreatedLeadA, JSON.stringify({
        companyName: "CI admin-created lead", qualificationMetric: 1, qualification: "Automated_Setup",
      })]
    );
    return client.query(
      `insert into tandem.leads
         (id, workspace_id, company_name, qualification_metric, pipeline_status, last_event_sequence)
       values ($1, $2, 'CI admin-created lead', 1, 'Automated_Setup', $3)`,
      [adminCreatedLeadA, workspaceA, event.rows[0].sequence]
    );
  });
  check("a workspace admin can materialize a new lead projection", adminCreatedLead.rowCount === 1);

  let agentLeadCreateBlocked = false;
  try {
    await withTandemSession(pool, agentUserA, (client) =>
      client.query(
        `insert into tandem.leads
           (id, workspace_id, company_name, qualification_metric, pipeline_status)
         values ($1, $2, 'Agent-created lead', 1, 'Automated_Setup')`,
        [agentCreatedLeadA, workspaceA]
      )
    );
  } catch {
    agentLeadCreateBlocked = true;
  }
  check("an agent cannot create an unassigned lead", agentLeadCreateBlocked);

  const agentOwnEvent = await withTandemSession(pool, agentUserA, (client) =>
    client.query(
      `insert into tandem.events
         (workspace_id, entity_type, entity_id, lead_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, 'lead', $2, $2, 'ci', 'ci-agent-own-lead-event', 'lead.lost', $3, now())`,
      [workspaceA, leadA, JSON.stringify({ reason: "CI write-policy check" })]
    )
  );
  check("an agent can append an event for their assigned lead", agentOwnEvent.rowCount === 1);

  const agentOwnProjection = await withTandemSession(pool, agentUserA, (client) =>
    client.query(
      `update tandem.leads
       set last_event_sequence = coalesce(last_event_sequence, 0) + 1
       where id = $1`,
      [leadA]
    )
  );
  check("an agent can update only their own lead projection", agentOwnProjection.rowCount === 1);

  let agentCrossTenantEventBlocked = false;
  try {
    await withTandemSession(pool, agentUserA, (client) =>
      client.query(
        `insert into tandem.events
           (workspace_id, entity_type, entity_id, lead_id, source, source_event_id, event_type, payload, occurred_at)
         values ($1, 'lead', $2, $2, 'ci', 'ci-agent-cross-tenant-event', 'lead.lost', $3, now())`,
        [workspaceB, leadB, JSON.stringify({ reason: "must be blocked" })]
      )
    );
  } catch {
    agentCrossTenantEventBlocked = true;
  }
  check("an agent cannot append an event for another workspace's lead", agentCrossTenantEventBlocked);

  // Nest's Add agent action uses this existing Core configuration boundary:
  // a manager can create an operational profile, but an agent cannot grant
  // themselves teammates or a cross-tenant profile.
  const adminCreatedAgent = await withTandemSession(pool, userA, (client) =>
    client.query(
      "insert into tandem.agents (id, workspace_id, display_name) values ($1, $2, 'CI manager-created agent')",
      [adminCreatedAgentA, workspaceA]
    )
  );
  check("a workspace admin can create an agent profile", adminCreatedAgent.rowCount === 1);

  let agentProfileCreateBlocked = false;
  try {
    await withTandemSession(pool, agentUserA, (client) =>
      client.query(
        "insert into tandem.agents (workspace_id, display_name) values ($1, 'CI agent-created profile')",
        [workspaceA]
      )
    );
  } catch {
    agentProfileCreateBlocked = true;
  }
  check("an agent cannot create another agent profile", agentProfileCreateBlocked);

  const crossTenantAgentRead = await withTandemSession(pool, userB, (client) =>
    client.query("select id from tandem.agents where id = $1", [adminCreatedAgentA])
  );
  check("workspace B's owner cannot read workspace A's agent profile", crossTenantAgentRead.rows.length === 0);

  // Ramp's template is admin-managed; the agent owns the normal progress
  // events for their own profile, while an explicit reopening of a past
  // certification is an admin decision.
  const adminOnboardingStep = await withTandemSession(pool, userA, (client) =>
    client.query(
      `insert into tandem.onboarding_steps (id, workspace_id, code, label, required)
       values ($1, $2, 'agreement_signed', 'Agreement signed', true)`,
      [onboardingStepA, workspaceA]
    )
  );
  check("a workspace admin can configure an onboarding step", adminOnboardingStep.rowCount === 1);

  let agentOnboardingConfigBlocked = false;
  try {
    await withTandemSession(pool, agentUserA, (client) =>
      client.query(
        `insert into tandem.onboarding_steps (workspace_id, code, label, required)
         values ($1, 'agent-added-step', 'Agent-added step', true)`,
        [workspaceA]
      )
    );
  } catch {
    agentOnboardingConfigBlocked = true;
  }
  check("an agent cannot change the onboarding template", agentOnboardingConfigBlocked);

  const agentOnboardingStart = await withTandemSession(pool, agentUserA, (client) =>
    client.query(
      `insert into tandem.agent_events
         (workspace_id, agent_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, 'ci', 'ci-agent-onboarding-start', 'onboarding.started', '{}'::jsonb, now())`,
      [workspaceA, agentA]
    )
  );
  check("an agent can start their own onboarding", agentOnboardingStart.rowCount === 1);

  let agentReopenBlocked = false;
  try {
    await withTandemSession(pool, agentUserA, (client) =>
      client.query(
        `insert into tandem.agent_events
           (workspace_id, agent_id, source, source_event_id, event_type, payload, occurred_at)
         values ($1, $2, 'ci', 'ci-agent-forbidden-reopen', 'onboarding.reopened', '{}'::jsonb, now())`,
        [workspaceA, agentA]
      )
    );
  } catch {
    agentReopenBlocked = true;
  }
  check("an agent cannot reopen their own certification", agentReopenBlocked);

  const adminReopen = await withTandemSession(pool, userA, (client) =>
    client.query(
      `insert into tandem.agent_events
         (workspace_id, agent_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, 'ci', 'ci-admin-reopen', 'onboarding.reopened', '{}'::jsonb, now())`,
      [workspaceA, agentA]
    )
  );
  check("a workspace admin can reopen certification", adminReopen.rowCount === 1);

  const agentOwnOnboardingProjection = await withTandemSession(pool, agentUserA, (client) =>
    client.query(
      "update tandem.agent_onboarding_status set started_at = now() where workspace_id = $1 and agent_id = $2",
      [workspaceA, agentA]
    )
  );
  check("an agent can update only their own onboarding projection", agentOwnOnboardingProjection.rowCount === 1);

  const crossTenantOnboardingRead = await withTandemSession(pool, userB, (client) =>
    client.query(
      "select agent_id from tandem.agent_onboarding_status where workspace_id = $1 and agent_id = $2",
      [workspaceA, agentA]
    )
  );
  check("workspace B's owner cannot read workspace A's onboarding", crossTenantOnboardingRead.rows.length === 0);

  // Routing is workspace configuration: every member may read the current
  // strategy, but only an owner/admin may create or change it.
  const adminRoutingInsert = await withTandemSession(pool, userA, (client) =>
    client.query(
      "insert into tandem.routing_settings (workspace_id, strategy) values ($1, 'round_robin')",
      [workspaceA]
    )
  );
  check("a workspace admin can set routing strategy", adminRoutingInsert.rowCount === 1);

  const agentRoutingRead = await withTandemSession(pool, agentUserA, (client) =>
    client.query("select strategy from tandem.routing_settings where workspace_id = $1", [workspaceA])
  );
  check(
    "an agent can read their workspace routing strategy",
    agentRoutingRead.rows.length === 1 && agentRoutingRead.rows[0].strategy === "round_robin"
  );

  const agentRoutingUpdate = await withTandemSession(pool, agentUserA, (client) =>
    client.query("update tandem.routing_settings set strategy = 'manual' where workspace_id = $1", [workspaceA])
  );
  check("an agent cannot change routing strategy", agentRoutingUpdate.rowCount === 0);

  const crossTenantRoutingRead = await withTandemSession(pool, userB, (client) =>
    client.query("select strategy from tandem.routing_settings where workspace_id = $1", [workspaceA])
  );
  check("workspace B's owner cannot read workspace A's routing strategy", crossTenantRoutingRead.rows.length === 0);

  const adminRoutingUpdate = await withTandemSession(pool, userA, (client) =>
    client.query("update tandem.routing_settings set strategy = 'least_loaded' where workspace_id = $1", [workspaceA])
  );
  check("a workspace admin can change routing strategy", adminRoutingUpdate.rowCount === 1);

  // Trail follows Core's own-lead rule: an assigned agent may append and
  // correct activity on their lead, but may never touch another tenant's
  // history. The event log stays append-only; the entry is a projection.
  const agentTrailEvent = await withTandemSession(pool, agentUserA, (client) =>
    client.query(
      `insert into tandem.trail_events
         (workspace_id, lead_id, entry_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, $3, 'ci', 'ci-agent-trail-visit', 'trail.visit_logged', $4, now())`,
      [workspaceA, leadA, trailEntryA, JSON.stringify({
        channel: "phone", confidenceRating: 6, salesStage: "Contacted", note: "CI trail visit",
      })]
    )
  );
  check("an agent can append activity for their assigned lead", agentTrailEvent.rowCount === 1);

  const agentTrailProjection = await withTandemSession(pool, agentUserA, (client) =>
    client.query(
      `insert into tandem.trail_entries
         (id, workspace_id, lead_id, channel, confidence_rating, sales_stage, note, logged_at, last_event_sequence)
       values ($1, $2, $3, 'phone', 6, 'Contacted', 'CI trail visit', now(), 1)`,
      [trailEntryA, workspaceA, leadA]
    )
  );
  check("an agent can materialize their own Trail projection", agentTrailProjection.rowCount === 1);

  const agentTrailUpdate = await withTandemSession(pool, agentUserA, (client) =>
    client.query("update tandem.trail_entries set note = 'CI corrected trail visit' where id = $1", [trailEntryA])
  );
  check("an agent can correct their own-lead Trail projection", agentTrailUpdate.rowCount === 1);

  const crossTenantTrailRead = await withTandemSession(pool, userB, (client) =>
    client.query("select id from tandem.trail_entries where id = $1", [trailEntryA])
  );
  check("workspace B's owner cannot read workspace A's Trail entry", crossTenantTrailRead.rows.length === 0);

  let agentCrossTenantTrailBlocked = false;
  try {
    await withTandemSession(pool, agentUserA, (client) =>
      client.query(
        `insert into tandem.trail_events
           (workspace_id, lead_id, entry_id, source, source_event_id, event_type, payload, occurred_at)
         values ($1, $2, $3, 'ci', 'ci-agent-cross-tenant-trail', 'trail.visit_logged', $4, now())`,
        [workspaceB, leadB, randomUUID(), JSON.stringify({
          channel: "phone", confidenceRating: 6, salesStage: "Contacted", note: "must be blocked",
        })]
      )
    );
  } catch {
    agentCrossTenantTrailBlocked = true;
  }
  check("an agent cannot append Trail activity in another workspace", agentCrossTenantTrailBlocked);

  // Coaster must follow the same tenant and role boundaries as Core: the
  // assigned agent can read their own lead's dispute, but only a workspace
  // admin may append an operator question or resolution.
  const disputesAsAgent = await withTandemSession(pool, agentUserA, (client) =>
    client.query("select id from tandem.disputes order by id")
  );
  check(
    "an assigned agent sees only workspace A's own disputes",
    disputesAsAgent.rows.length === 2 && disputesAsAgent.rows.some((row) => row.id === policyDisputeA)
  );

  const crossTenantDisputeRead = await withTandemSession(pool, userB, (client) =>
    client.query("select id from tandem.disputes where id = $1", [policyDisputeA])
  );
  check("workspace B's owner cannot read workspace A's dispute", crossTenantDisputeRead.rows.length === 0);

  let agentResolutionBlocked = false;
  try {
    await withTandemSession(pool, agentUserA, (client) =>
      client.query(
        `insert into tandem.dispute_events
           (workspace_id, dispute_id, lead_id, payout_id, source, source_event_id, event_type, payload, occurred_at)
         values ($1, $2, $3, $4, 'ci', 'ci-agent-forbidden-resolution', 'dispute.resolved', $5, now())`,
        [workspaceA, policyDisputeA, leadA, payoutA, JSON.stringify({ outcome: "upheld", note: "Agent must not resolve" })]
      )
    );
  } catch {
    agentResolutionBlocked = true;
  }
  check("an agent cannot resolve a dispute", agentResolutionBlocked);

  const adminQuery = await withTandemSession(pool, userA, (client) =>
    client.query(
      `insert into tandem.dispute_events
         (workspace_id, dispute_id, lead_id, payout_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, $3, $4, 'ci', 'ci-admin-dispute-query', 'dispute.queried', $5, now())`,
      [workspaceA, policyDisputeA, leadA, payoutA, JSON.stringify({ question: "Please provide evidence" })]
    )
  );
  check("a workspace admin can append an operator dispute event", adminQuery.rowCount === 1);

  // Migration 013 added an admin-only UPDATE policy on tandem.payouts. An
  // admin (workspace A's owner) must be able to move a payout through its
  // lifecycle; without this grant/policy no app-layer writer running as
  // `authenticated` could ever approve or pay a commission.
  const adminApprove = await withTandemSession(pool, userA, (client) =>
    client.query("update tandem.payouts set status = 'approved' where id = $1", [payoutA])
  );
  check("workspace A's admin can update payoutA's status", adminApprove.rowCount === 1);

  const payoutAfterApprove = await withTandemSession(pool, userA, (client) =>
    client.query("select status from tandem.payouts where id = $1", [payoutA])
  );
  check(
    "payoutA's status actually changed to approved",
    payoutAfterApprove.rows.length === 1 && payoutAfterApprove.rows[0].status === "approved"
  );

  // The same update as a non-admin agent in the same workspace must affect
  // zero rows: payouts UPDATE is admin-only with no agent branch, even though
  // payoutA is tied to this agent's own lead (leads.assignee_id = agentA).
  // RLS on UPDATE with no matching USING clause returns 0 rows affected, not
  // an error, so the row-count-affected pattern is the right assertion here.
  const agentApprove = await withTandemSession(pool, agentUserA, (client) =>
    client.query("update tandem.payouts set status = 'paid' where id = $1", [payoutA])
  );
  check("a non-admin agent cannot update any payout (0 rows affected)", agentApprove.rowCount === 0);

  const payoutAfterAgentAttempt = await withTandemSession(pool, userA, (client) =>
    client.query("select status from tandem.payouts where id = $1", [payoutA])
  );
  check(
    "payoutA's status is unchanged after the agent's blocked update",
    payoutAfterAgentAttempt.rows.length === 1 && payoutAfterAgentAttempt.rows[0].status === "approved"
  );

  // Cross-tenant: workspace B's owner updating workspace A's payout must also
  // affect zero rows, same as the cross-tenant read check above.
  const crossTenantUpdate = await withTandemSession(pool, userB, (client) =>
    client.query("update tandem.payouts set status = 'voided' where id = $1", [payoutA])
  );
  check("user B's update of workspace A's payout affects zero rows", crossTenantUpdate.rowCount === 0);

  // Migration 013 also added an admin-only INSERT policy on
  // tandem.payout_ledger. An admin must be able to record a transition...
  const adminLedgerInsert = await withTandemSession(pool, userA, (client) =>
    client.query(
      `insert into tandem.payout_ledger (workspace_id, payout_id, event_id, from_status, to_status)
       values ($1, $2, $3, 'held', 'approved')`,
      [workspaceA, payoutA, payoutEventA]
    )
  );
  check("workspace A's admin can insert a payout_ledger row", adminLedgerInsert.rowCount === 1);

  // ...but a non-admin agent cannot. Unlike UPDATE, RLS on INSERT with a
  // failing WITH CHECK raises a policy violation error rather than silently
  // affecting 0 rows, so this check PASSES when the insert throws.
  let agentLedgerInsertBlocked = false;
  try {
    await withTandemSession(pool, agentUserA, (client) =>
      client.query(
        `insert into tandem.payout_ledger (workspace_id, payout_id, event_id, from_status, to_status)
         values ($1, $2, $3, 'held', 'approved')`,
        [workspaceA, payoutA, payoutEventA]
      )
    );
  } catch {
    agentLedgerInsertBlocked = true;
  }
  check("a non-admin agent cannot insert a payout_ledger row", agentLedgerInsertBlocked);

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
