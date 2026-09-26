#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createTandemPool } from "tandem-crm/db";
import { replayLeadEvents } from "tandem-crm";
import { replayAgentOnboardingEvents } from "tandem-crm";

const now = Date.now();
const daysAgo = (n) => new Date(now - n * 86_400_000).toISOString();

// Demo user ids stay fixed because the browser's identity switcher
// (components/user-switcher.tsx) references them directly. Exported so a
// live-demo reset job (bin/reset-demo-workspace.mjs) can reseed the exact
// same fixed personas the switcher expects, not just a fresh random set.
export const DEMO_USER_IDS = {
  owner: "c0000000-0000-0000-0000-000000000001",
  amira: "c0000000-0000-0000-0000-000000000002",
  farid: "c0000000-0000-0000-0000-000000000003",
  siti: "c0000000-0000-0000-0000-000000000004",
  wei: "c0000000-0000-0000-0000-000000000005",
};

/**
 * Seeds one full demo workspace: two territories, four agents (with a mix
 * of onboarding progress), five members (one owner + four agents), and six
 * leads spanning the whole pipeline (a fresh lead, one lost, one won with
 * no payment yet, a held commission, a fully paid commission). Refuses to
 * run if `workspaceId` already exists -- Tandem's event logs are
 * append-only, so a seed can never pretend to erase and restart a prior
 * workspace's history.
 *
 * @param {import("pg").Pool} pool
 * @param {string} workspaceId
 */
export async function seedDemoWorkspace(pool, workspaceId) {
  const WORKSPACE_ID = workspaceId;
  const ids = {
    territoryNorth: randomUUID(),
    territorySouth: randomUUID(),
    agentAmira: randomUUID(),
    agentFarid: randomUUID(),
    agentSiti: randomUUID(),
    agentWei: randomUUID(),
    userOwner: DEMO_USER_IDS.owner,
    userAmira: DEMO_USER_IDS.amira,
    userFarid: DEMO_USER_IDS.farid,
    userSiti: DEMO_USER_IDS.siti,
    userWei: DEMO_USER_IDS.wei,
  };

  let eventCounter = 0;
  function nextSourceEventId() {
    eventCounter += 1;
    return `seed-${eventCounter}`;
  }

  function leadEvent(leadId, type, data, occurredAt) {
    return {
      id: randomUUID(), sequence: 0, workspaceId: WORKSPACE_ID, leadId,
      source: "seed", sourceEventId: nextSourceEventId(), occurredAt, type, data,
    };
  }

  function onboardingEvent(agentId, type, data, occurredAt) {
    return {
      id: randomUUID(), sequence: 0, workspaceId: WORKSPACE_ID, agentId,
      source: "seed", sourceEventId: nextSourceEventId(), occurredAt, type, data,
    };
  }

  /** Inserts a lead's full event history, replays it locally to build the
   * projection row (so the projection can never drift from what the events
   * actually say), then writes both. */
  async function insertLead(client, { id, companyName, qualificationMetric, assigneeId, territoryId, events }) {
    let sequence = 1;
    for (const e of events) {
      await client.query(
        `insert into tandem.events
           (id, workspace_id, entity_type, entity_id, lead_id, source, source_event_id, event_type, payload, occurred_at)
         values ($1, $2, 'lead', $3, $3, $4, $5, $6, $7, $8)`,
        [e.id, WORKSPACE_ID, id, e.source, e.sourceEventId, e.type, JSON.stringify(e.data), e.occurredAt]
      );
      e.sequence = sequence++;
    }
    const state = replayLeadEvents(events, WORKSPACE_ID, id);
    await client.query(
      `insert into tandem.leads
         (id, workspace_id, company_name, qualification_metric, pipeline_status, sales_stage, assignee_id, territory_id, last_event_sequence)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, WORKSPACE_ID, companyName, qualificationMetric, state.status, state.salesStage, assigneeId, territoryId, state.lastSequence]
    );
    if (state.commission) {
      await client.query(
        `insert into tandem.payouts
           (id, workspace_id, lead_id, partner_id, amount_minor, currency, hold_days, payment_confirmed_at, release_at, status, last_event_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          state.commission.payoutId, WORKSPACE_ID, id, state.commission.partnerId,
          state.commission.amountMinor, state.commission.currency, 30,
          state.payment.confirmedAt, state.commission.releaseAt, state.commission.status,
          events[events.length - 1].id,
        ]
      );
    }
  }

  async function insertAgentOnboarding(client, agentId, events) {
    let sequence = 1;
    for (const e of events) {
      await client.query(
        `insert into tandem.agent_events
           (id, workspace_id, agent_id, source, source_event_id, event_type, payload, occurred_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [e.id, WORKSPACE_ID, agentId, e.source, e.sourceEventId, e.type, JSON.stringify(e.data), e.occurredAt]
      );
      e.sequence = sequence++;
    }
    const state = events.length > 0 ? replayAgentOnboardingEvents(events, WORKSPACE_ID, agentId) : null;
    await client.query(
      `insert into tandem.agent_onboarding_status (workspace_id, agent_id, started_at, certified_at, last_event_sequence)
       values ($1, $2, $3, $4, $5)`,
      [WORKSPACE_ID, agentId, state?.startedAt ?? null, state?.certifiedAt ?? null, state?.lastSequence ?? null]
    );
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const existing = await client.query("select 1 from tandem.workspaces where id = $1", [WORKSPACE_ID]);
    if ((existing.rowCount ?? 0) > 0) {
      throw new Error(
        `demo workspace ${WORKSPACE_ID} already exists; choose a new workspace id instead of deleting append-only history`
      );
    }

    await client.query("insert into tandem.workspaces (id, slug) values ($1, $2)", [WORKSPACE_ID, `demo-${WORKSPACE_ID}`]);

    await client.query(
      `insert into tandem.territories (id, workspace_id, name, code) values
         ($1, $2, 'North', 'north'), ($3, $2, 'South', 'south')`,
      [ids.territoryNorth, WORKSPACE_ID, ids.territorySouth]
    );

    await client.query(
      `insert into tandem.agents (id, workspace_id, display_name) values
         ($1, $5, 'Amira Rahman'), ($2, $5, 'Farid Hassan'), ($3, $5, 'Siti Aminah'), ($4, $5, 'Wei Chen')`,
      [ids.agentAmira, ids.agentFarid, ids.agentSiti, ids.agentWei, WORKSPACE_ID]
    );

    await client.query(
      `insert into tandem.agent_territories (workspace_id, agent_id, territory_id) values
         ($1, $2, $3), ($1, $4, $3), ($1, $5, $6)`,
      [WORKSPACE_ID, ids.agentAmira, ids.territoryNorth, ids.agentFarid, ids.agentSiti, ids.territorySouth]
    );
    await client.query(
      `insert into tandem.agent_territories (workspace_id, agent_id, territory_id) values ($1, $2, $3)`,
      [WORKSPACE_ID, ids.agentWei, ids.territoryNorth]
    );

    await client.query(
      `insert into tandem.members (workspace_id, user_id, role, agent_id) values
         ($1, $2, 'owner', null),
         ($1, $3, 'agent', $7),
         ($1, $4, 'agent', $8),
         ($1, $5, 'agent', $9),
         ($1, $6, 'agent', $10)`,
      [
        WORKSPACE_ID, ids.userOwner, ids.userAmira, ids.userFarid, ids.userSiti, ids.userWei,
        ids.agentAmira, ids.agentFarid, ids.agentSiti, ids.agentWei,
      ]
    );

    await client.query(
      `insert into tandem.commission_rules (workspace_id, product_tag, currency, basis_points, hold_days) values
         ($1, 'fleet-telematics', 'MYR', 1000, 30)`,
      [WORKSPACE_ID]
    );

    await client.query(
      `insert into tandem.onboarding_steps (workspace_id, code, label, sort_order) values
         ($1, 'agreement_signed', 'Partner agreement signed', 1),
         ($1, 'product_training', 'Product training complete', 2),
         ($1, 'shadowed_call', 'Shadowed a live customer call', 3)`,
      [WORKSPACE_ID]
    );

    await client.query(
      `insert into tandem.waypoint_settings (workspace_id, strategy) values ($1, 'round_robin')`,
      [WORKSPACE_ID]
    );

    // Onboarding: Amira fully certified, Farid in progress, Siti not started, Wei certified.
    await insertAgentOnboarding(client, ids.agentAmira, [
      onboardingEvent(ids.agentAmira, "onboarding.started", {}, daysAgo(60)),
      onboardingEvent(ids.agentAmira, "onboarding.step_completed", { stepCode: "agreement_signed" }, daysAgo(58)),
      onboardingEvent(ids.agentAmira, "onboarding.step_completed", { stepCode: "product_training" }, daysAgo(55)),
      onboardingEvent(ids.agentAmira, "onboarding.step_completed", { stepCode: "shadowed_call" }, daysAgo(50)),
      onboardingEvent(ids.agentAmira, "onboarding.certified", {}, daysAgo(49)),
    ]);
    await insertAgentOnboarding(client, ids.agentFarid, [
      onboardingEvent(ids.agentFarid, "onboarding.started", {}, daysAgo(10)),
      onboardingEvent(ids.agentFarid, "onboarding.step_completed", { stepCode: "agreement_signed" }, daysAgo(9)),
      onboardingEvent(ids.agentFarid, "onboarding.step_completed", { stepCode: "product_training" }, daysAgo(6)),
    ]);
    await insertAgentOnboarding(client, ids.agentSiti, []);
    await insertAgentOnboarding(client, ids.agentWei, [
      onboardingEvent(ids.agentWei, "onboarding.started", {}, daysAgo(90)),
      onboardingEvent(ids.agentWei, "onboarding.step_completed", { stepCode: "agreement_signed" }, daysAgo(89)),
      onboardingEvent(ids.agentWei, "onboarding.step_completed", { stepCode: "product_training" }, daysAgo(85)),
      onboardingEvent(ids.agentWei, "onboarding.step_completed", { stepCode: "shadowed_call" }, daysAgo(80)),
      onboardingEvent(ids.agentWei, "onboarding.certified", {}, daysAgo(79)),
    ]);

    // Leads spanning the pipeline, real event histories. Each lead's id is
    // generated first so its own events can reference it.
    const paidAt = daysAgo(20);
    const releaseAt = daysAgo(-10); // 30 days after paidAt, still in the future relative to "now"

    const leadBorneo = randomUUID();
    await insertLead(client, {
      id: leadBorneo, companyName: "Borneo Freight Co", qualificationMetric: 8,
      assigneeId: ids.agentAmira, territoryId: ids.territoryNorth,
      events: [
        leadEvent(leadBorneo, "lead.created", { companyName: "Borneo Freight Co", qualificationMetric: 8, qualification: "Automated_Setup" }, daysAgo(3)),
      ],
    });

    const leadKenari = randomUUID();
    await insertLead(client, {
      id: leadKenari, companyName: "Kenari Logistics", qualificationMetric: 22,
      assigneeId: ids.agentFarid, territoryId: ids.territorySouth,
      events: [
        leadEvent(leadKenari, "lead.created", { companyName: "Kenari Logistics", qualificationMetric: 22, qualification: "Manual_Review" }, daysAgo(5)),
        leadEvent(leadKenari, "lead.assigned", { agentId: ids.agentFarid, territoryId: ids.territorySouth }, daysAgo(4)),
      ],
    });

    const leadPerak = randomUUID();
    await insertLead(client, {
      id: leadPerak, companyName: "Perak Transit", qualificationMetric: 5,
      assigneeId: ids.agentSiti, territoryId: ids.territorySouth,
      events: [
        leadEvent(leadPerak, "lead.created", { companyName: "Perak Transit", qualificationMetric: 5, qualification: "Automated_Setup" }, daysAgo(8)),
        leadEvent(leadPerak, "lead.assigned", { agentId: ids.agentSiti, territoryId: ids.territorySouth }, daysAgo(7)),
        leadEvent(leadPerak, "conversion.confirmed", {}, daysAgo(6)),
      ],
    });

    const leadRimba = randomUUID();
    await insertLead(client, {
      id: leadRimba, companyName: "Rimba Haulage", qualificationMetric: 14,
      assigneeId: ids.agentAmira, territoryId: ids.territoryNorth,
      events: [
        leadEvent(leadRimba, "lead.created", { companyName: "Rimba Haulage", qualificationMetric: 14, qualification: "Manual_Review" }, daysAgo(30)),
        leadEvent(leadRimba, "lead.assigned", { agentId: ids.agentAmira, territoryId: ids.territoryNorth }, daysAgo(29)),
        leadEvent(leadRimba, "conversion.confirmed", {}, daysAgo(25)),
        leadEvent(leadRimba, "payment.confirmed", { amountMinor: 480_000, currency: "MYR" }, paidAt),
        leadEvent(leadRimba, "commission.held", { payoutId: randomUUID(), partnerId: "borneo-freight", amountMinor: 48_000, currency: "MYR", releaseAt }, paidAt),
      ],
    });

    const leadDelta = randomUUID();
    const deltaPayoutId = randomUUID();
    const deltaPaidAt = daysAgo(50);
    const deltaReleaseAt = daysAgo(20);
    await insertLead(client, {
      id: leadDelta, companyName: "Delta Cargo Sdn Bhd", qualificationMetric: 40,
      assigneeId: ids.agentWei, territoryId: ids.territoryNorth,
      events: [
        leadEvent(leadDelta, "lead.created", { companyName: "Delta Cargo Sdn Bhd", qualificationMetric: 40, qualification: "Manual_Review" }, daysAgo(70)),
        leadEvent(leadDelta, "lead.assigned", { agentId: ids.agentWei, territoryId: ids.territoryNorth }, daysAgo(69)),
        leadEvent(leadDelta, "conversion.confirmed", {}, daysAgo(60)),
        leadEvent(leadDelta, "payment.confirmed", { amountMinor: 1_200_000, currency: "MYR" }, deltaPaidAt),
        leadEvent(leadDelta, "commission.held", { payoutId: deltaPayoutId, partnerId: "delta-cargo", amountMinor: 120_000, currency: "MYR", releaseAt: deltaReleaseAt }, deltaPaidAt),
        leadEvent(leadDelta, "commission.eligible", { payoutId: deltaPayoutId }, deltaReleaseAt),
        leadEvent(leadDelta, "commission.approved", { payoutId: deltaPayoutId }, deltaReleaseAt),
        leadEvent(leadDelta, "commission.paid", { payoutId: deltaPayoutId, payoutReference: "payrun-2026-08" }, deltaReleaseAt),
      ],
    });

    const leadUtara = randomUUID();
    await insertLead(client, {
      id: leadUtara, companyName: "Utara Express", qualificationMetric: 3,
      assigneeId: ids.agentFarid, territoryId: ids.territorySouth,
      events: [
        leadEvent(leadUtara, "lead.created", { companyName: "Utara Express", qualificationMetric: 3, qualification: "Automated_Setup" }, daysAgo(15)),
        leadEvent(leadUtara, "lead.assigned", { agentId: ids.agentFarid, territoryId: ids.territorySouth }, daysAgo(14)),
        leadEvent(leadUtara, "lead.lost", { reason: "Chose a competitor" }, daysAgo(12)),
      ],
    });

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// CLI wrapper, unchanged behavior from before this file was refactored into
// an exported function: `node scripts/seed.mjs` still works exactly as
// documented in the README, reading SEED_DATABASE_URL/DATABASE_URL and an
// optional TANDEM_WORKSPACE_ID from the environment.
if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createTandemPool(process.env.SEED_DATABASE_URL ?? process.env.DATABASE_URL);
  const workspaceId = process.env.TANDEM_WORKSPACE_ID ?? randomUUID();
  seedDemoWorkspace(pool, workspaceId)
    .then(() => {
      console.log("Seeded workspace", workspaceId);
      console.log(`Start the dashboard with TANDEM_WORKSPACE_ID=${workspaceId}`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
