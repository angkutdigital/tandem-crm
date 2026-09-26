"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import {
  replayLeadEvents,
  replayAgentOnboardingEvents,
  replayTrailEntryEvents,
  selectAgentForLead,
  qualifyLead,
  defaultTandemConfig,
  trailVisitChannels,
  trailSalesStages,
  type TandemEvent,
  type AgentOnboardingEvent,
  type TrailEvent,
  type TrailVisitChannel,
  type TrailSalesStage,
} from "tandem-crm";
import { withTandemSession } from "tandem-crm/db";
import { pool, WORKSPACE_ID } from "./db";
import { setDemoUser } from "./auth";
import { requireCurrentMember, getOnboardingSteps, getRoutingStrategy } from "./queries";

async function loadLeadEvents(client: import("pg").PoolClient, leadId: string): Promise<TandemEvent[]> {
  const result = await client.query<{
    id: string; sequence: number; event_type: string; payload: Record<string, unknown>; occurred_at: string;
    source: string; source_event_id: string;
  }>(
    `select id, sequence, event_type, payload, occurred_at, source, source_event_id
     from tandem.events where lead_id = $1 and workspace_id = $2 order by sequence`,
    [leadId, WORKSPACE_ID]
  );
  return result.rows.map((row) => ({
    // sequence is bigint in Postgres, which node-postgres returns as a
    // string; leaving it as a string here would silently turn `sequence + 1`
    // into string concatenation ("11" instead of 2) for the next event.
    // occurred_at is timestamptz, which node-postgres parses into a Date,
    // not the ISO string the reducer's validation expects.
    id: row.id, sequence: Number(row.sequence), workspaceId: WORKSPACE_ID, leadId,
    source: row.source, sourceEventId: row.source_event_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    type: row.event_type, data: row.payload,
  })) as TandemEvent[];
}

/** Appends one new event to a lead's history, validated by replaying the
 * full history (existing + new) through the same reducer the package
 * ships, then writes the event and the resulting projection row in one
 * transaction -- the "validate and append in one transaction" contract the
 * README describes for a projection writer. */
async function appendLeadEvent(
  leadId: string,
  type: TandemEvent["type"],
  data: TandemEvent["data"],
  idempotency?: { source: string; sourceEventId: string }
): Promise<void> {
  const member = await requireCurrentMember();
  await withTandemSession(pool, member.userId, async (client) => {
    const existing = await loadLeadEvents(client, leadId);
    const nextSequence = existing.length > 0 ? existing[existing.length - 1].sequence + 1 : 1;
    const newEvent = {
      id: randomUUID(), sequence: nextSequence, workspaceId: WORKSPACE_ID, leadId,
      source: idempotency?.source ?? "dashboard",
      sourceEventId: idempotency?.sourceEventId ?? `dashboard-${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      type, data,
    } as TandemEvent;

    // Throws on an illegal transition -- this IS the validation, not a
    // separate check, so it can't drift from what the reducer actually
    // enforces everywhere else.
    const state = replayLeadEvents([...existing, newEvent], WORKSPACE_ID, leadId);
    if (!state) throw new Error("lead has no state after append");

    await client.query(
      `insert into tandem.events
         (id, workspace_id, entity_type, entity_id, lead_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, 'lead', $3, $3, $4, $5, $6, $7, $8)`,
      [newEvent.id, WORKSPACE_ID, leadId, newEvent.source, newEvent.sourceEventId, newEvent.type, JSON.stringify(newEvent.data), newEvent.occurredAt]
    );
    await client.query(
      `update tandem.leads
       set pipeline_status = $2, assignee_id = coalesce($3, assignee_id), territory_id = coalesce($4, territory_id),
           last_event_sequence = $5, updated_at = now()
       where id = $1 and workspace_id = $6`,
      [leadId, state.status, state.agentId, state.territoryId, state.lastSequence, WORKSPACE_ID]
    );

    if (state.commission && type === "commission.held") {
      await client.query(
        `insert into tandem.payouts
           (id, workspace_id, lead_id, partner_id, amount_minor, currency, hold_days, payment_confirmed_at, release_at, status, last_event_id)
         values ($1, $2, $3, $4, $5, $6, 30, $7, $8, $9, $10)`,
        [
          state.commission.payoutId, WORKSPACE_ID, leadId, state.commission.partnerId,
          state.commission.amountMinor, state.commission.currency, state.payment!.confirmedAt,
          state.commission.releaseAt, state.commission.status, newEvent.id,
        ]
      );
      await client.query(
        `insert into tandem.payout_ledger
           (workspace_id, payout_id, event_id, from_status, to_status)
         values ($1, $2, $3, null, $4)`,
        [WORKSPACE_ID, state.commission.payoutId, newEvent.id, state.commission.status]
      );
    } else if (state.commission) {
      // A payout is a rebuildable projection, just like a lead. The event
      // above is the source of truth; this row must reflect the reducer's
      // resulting commission state in the same transaction or the dashboard
      // can claim an upheld dispute was applied while the money projection
      // still shows its old amount/status.
      const payoutResult = await client.query<{ status: string }>(
        `select status from tandem.payouts
         where id = $1 and workspace_id = $2
         for update`,
        [state.commission.payoutId, WORKSPACE_ID]
      );
      const payout = payoutResult.rows[0];
      if (!payout) throw new Error("commission has no payout projection");

      const clawback = state.commission.clawback;
      await client.query(
        `update tandem.payouts
         set amount_minor = $3,
             release_at = $4,
             status = $5,
             last_event_id = $6,
             approved_at = case when $5 = 'approved' then coalesce(approved_at, $7) else approved_at end,
             paid_at = case when $5 = 'paid' then coalesce(paid_at, $7) else paid_at end,
             voided_at = case when $5 = 'voided' then coalesce(voided_at, $7) else voided_at end,
             clawback_amount_minor = $8,
             clawback_reason = $9,
             clawback_requested_at = $10,
             updated_at = now()
         where id = $1 and workspace_id = $2`,
        [
          state.commission.payoutId, WORKSPACE_ID, state.commission.amountMinor,
          state.commission.releaseAt, state.commission.status, newEvent.id,
          newEvent.occurredAt, clawback?.amountMinor ?? null,
          clawback?.reason ?? null, clawback?.requestedAt ?? null,
        ]
      );
      await client.query(
        `insert into tandem.payout_ledger
           (workspace_id, payout_id, event_id, from_status, to_status)
         values ($1, $2, $3, $4, $5)`,
        [WORKSPACE_ID, state.commission.payoutId, newEvent.id, payout.status, state.commission.status]
      );
    }
  });
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/");
}

export async function markLeadWon(leadId: string): Promise<void> {
  await appendLeadEvent(leadId, "conversion.confirmed", {});
}

export async function markLeadLost(leadId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new Error("a reason is required to mark a lead lost");
  await appendLeadEvent(leadId, "lead.lost", { reason });
}

/** Called when a kanban card is dragged into a new column. Not every column
 * pair is a real transition: Won -> Commission_Hold needs a partner/amount/
 * release date, Commission_Hold -> Commission_Eligible needs the release
 * date to have passed, and so on through the rest of the money pipeline --
 * none of that exists at the moment someone drags a card, so those columns
 * are display-only destinations, not drop targets. Only the two
 * transitions a drag actually has enough information for are allowed here;
 * the UI must catch a thrown error from an unsupported drop and revert the
 * card to its original column rather than leave the board lying about
 * what's in the database. */
export async function moveLeadStatus(leadId: string, targetStatus: string): Promise<void> {
  if (targetStatus === "Won") {
    await markLeadWon(leadId);
    return;
  }
  if (targetStatus === "Lost") {
    await markLeadLost(leadId, "Moved to Lost on the kanban board");
    return;
  }
  throw new Error(`"${targetStatus.replace(/_/g, " ")}" isn't a status you can drag a lead into -- it needs data a drag can't supply.`);
}

/** Assigns a lead to a specific agent directly (from the lead detail page's
 * manual override), or -- when agentId is omitted -- asks
 * selectAgentForLead() to recommend one from the workspace's current
 * routing strategy and the agents covering the lead's territory. Either
 * way, Tandem only recommends or records; this function is the
 * "implementing application" deciding to act on it. */
export async function assignLead(leadId: string, agentId?: string): Promise<void> {
  const member = await requireCurrentMember();
  let resolvedAgentId = agentId ?? null;
  let territoryId: string | null = null;

  await withTandemSession(pool, member.userId, async (client) => {
    const leadRow = await client.query<{ territory_id: string | null; assignee_id: string | null }>(
      `select territory_id, assignee_id from tandem.leads where id = $1 and workspace_id = $2`,
      [leadId, WORKSPACE_ID]
    );
    territoryId = leadRow.rows[0]?.territory_id ?? null;

    if (!resolvedAgentId) {
      if (!territoryId) throw new Error("lead has no territory to route within");
      const strategy = await getRoutingStrategy(member.userId);
      const candidatesResult = await client.query<{ agent_id: string; open_lead_count: string }>(
        `select at.agent_id, (
           select count(*) from tandem.leads l
           where l.workspace_id = at.workspace_id and l.assignee_id = at.agent_id
             and l.pipeline_status not in ('Commission_Paid', 'Lost', 'Refunded')
         ) as open_lead_count
         from tandem.agent_territories at
         join tandem.agents a on a.id = at.agent_id and a.workspace_id = at.workspace_id and a.active
         where at.territory_id = $1 and at.workspace_id = $2`,
        [territoryId, WORKSPACE_ID]
      );
      const candidates = candidatesResult.rows.map((r) => ({ agentId: r.agent_id, openLeadCount: Number(r.open_lead_count) }));
      resolvedAgentId = selectAgentForLead(candidates, strategy, leadRow.rows[0]?.assignee_id ?? null);
      if (!resolvedAgentId) throw new Error("no eligible agent found for this lead's territory");
    }
  });

  await appendLeadEvent(leadId, "lead.assigned", { agentId: resolvedAgentId!, territoryId });
}

async function loadAgentEvents(client: import("pg").PoolClient, agentId: string): Promise<AgentOnboardingEvent[]> {
  const result = await client.query<{
    id: string; sequence: number; event_type: string; payload: Record<string, unknown>; occurred_at: string;
    source: string; source_event_id: string;
  }>(
    `select id, sequence, event_type, payload, occurred_at, source, source_event_id
     from tandem.agent_events where agent_id = $1 and workspace_id = $2 order by sequence`,
    [agentId, WORKSPACE_ID]
  );
  return result.rows.map((row) => ({
    // See loadLeadEvents: sequence is bigint (returned as a string) and
    // occurred_at is timestamptz (returned as a Date), not what the reducer
    // expects on its way back in.
    id: row.id, sequence: Number(row.sequence), workspaceId: WORKSPACE_ID, agentId,
    source: row.source, sourceEventId: row.source_event_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    type: row.event_type, data: row.payload,
  })) as AgentOnboardingEvent[];
}

async function appendOnboardingEvent(
  agentId: string,
  type: AgentOnboardingEvent["type"],
  data: AgentOnboardingEvent["data"]
): Promise<void> {
  const member = await requireCurrentMember();
  await withTandemSession(pool, member.userId, async (client) => {
    const existing = await loadAgentEvents(client, agentId);
    const nextSequence = existing.length > 0 ? existing[existing.length - 1].sequence + 1 : 1;
    const newEvent = {
      id: randomUUID(), sequence: nextSequence, workspaceId: WORKSPACE_ID, agentId,
      source: "dashboard", sourceEventId: `dashboard-${randomUUID()}`, occurredAt: new Date().toISOString(),
      type, data,
    } as AgentOnboardingEvent;

    const state = replayAgentOnboardingEvents([...existing, newEvent], WORKSPACE_ID, agentId);

    await client.query(
      `insert into tandem.agent_events
         (id, workspace_id, agent_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [newEvent.id, WORKSPACE_ID, agentId, newEvent.source, newEvent.sourceEventId, newEvent.type, JSON.stringify(newEvent.data), newEvent.occurredAt]
    );
    await client.query(
      `insert into tandem.agent_onboarding_status (workspace_id, agent_id, started_at, certified_at, last_event_sequence)
       values ($1, $2, $3, $4, $5)
       on conflict (workspace_id, agent_id) do update
         set started_at = excluded.started_at, certified_at = excluded.certified_at,
             last_event_sequence = excluded.last_event_sequence, updated_at = now()`,
      [WORKSPACE_ID, agentId, state?.startedAt ?? null, state?.certifiedAt ?? null, state?.lastSequence ?? null]
    );
  });
  revalidatePath("/agents");
  revalidatePath(`/agents/${agentId}`);
}

export async function completeOnboardingStep(agentId: string, stepCode: string, alreadyStarted: boolean): Promise<void> {
  if (!alreadyStarted) await appendOnboardingEvent(agentId, "onboarding.started", {});
  await appendOnboardingEvent(agentId, "onboarding.step_completed", { stepCode });
}

/** Certifying is the implementing application's call, same as any gate
 * Tandem tracks but doesn't enforce -- this only requires what the reducer
 * itself requires (onboarding started, not already certified), but the UI
 * that calls this only enables the button once every required step is
 * complete, applying isAgentCertified() as the actual business policy. */
export async function certifyAgent(agentId: string): Promise<void> {
  const member = await requireCurrentMember();
  const requiredSteps = (await getOnboardingSteps(member.userId)).filter((s) => s.required);
  const state = await withTandemSession(pool, member.userId, async (client) => {
    const events = await loadAgentEvents(client, agentId);
    return events.length > 0 ? replayAgentOnboardingEvents(events, WORKSPACE_ID, agentId) : null;
  });
  const completed = state?.completedStepCodes ?? [];
  const outstanding = requiredSteps.filter((step) => !completed.includes(step.code));
  if (outstanding.length > 0) {
    throw new Error(`required steps not yet complete: ${outstanding.map((s) => s.label).join(", ")}`);
  }
  await appendOnboardingEvent(agentId, "onboarding.certified", {});
}

/** Only an owner/admin may reopen a certification after the workspace changes
 * its requirements. The database enforces the same boundary as defence in
 * depth; this check gives the application a clear, immediate error too. */
export async function reopenAgentCertification(agentId: string): Promise<void> {
  const member = await requireCurrentMember();
  if (member.role !== "owner" && member.role !== "admin") {
    throw new Error("only a workspace owner or admin can reopen certification");
  }
  await appendOnboardingEvent(agentId, "onboarding.reopened", {});
}

export async function setRoutingStrategy(strategy: "round_robin" | "least_loaded" | "manual"): Promise<void> {
  const member = await requireCurrentMember();
  await withTandemSession(pool, member.userId, (client) =>
    client.query(
      `insert into tandem.routing_settings (workspace_id, strategy, updated_at) values ($1, $2, now())
       on conflict (workspace_id) do update set strategy = excluded.strategy, updated_at = now()`,
      [WORKSPACE_ID, strategy]
    )
  );
  revalidatePath("/settings/routing");
}

/** The one place a brand-new lead enters the system through this dashboard
 * (as opposed to a real integration's webhook adapter). Qualification is
 * computed the same way any adapter would: qualifyLead() against the
 * workspace's config, snapshotted onto the lead.created event the way the
 * README requires ("Event payloads must snapshot the qualification result
 * ... so later config edits cannot rewrite history"). */
export async function createLead(input: {
  companyName: string;
  contactPhone: string;
  qualificationMetric: number;
  productTag: string;
}): Promise<string> {
  const member = await requireCurrentMember();
  if (!input.companyName.trim()) throw new Error("company name is required");
  if (!input.contactPhone.trim()) throw new Error("contact phone is required");
  if (!input.productTag.trim()) throw new Error("product tag is required");

  const leadId = randomUUID();
  const qualification = qualifyLead({ qualificationMetric: input.qualificationMetric }, defaultTandemConfig);
  const newEvent = {
    id: randomUUID(), sequence: 1, workspaceId: WORKSPACE_ID, leadId,
    source: "dashboard", sourceEventId: `dashboard-${randomUUID()}`, occurredAt: new Date().toISOString(),
    type: "lead.created",
    data: {
      companyName: input.companyName.trim(), qualificationMetric: input.qualificationMetric,
      qualification: qualification.status,
    },
  } as TandemEvent;

  const state = replayLeadEvents([newEvent], WORKSPACE_ID, leadId);
  if (!state) throw new Error("lead has no state after creation");

  await withTandemSession(pool, member.userId, async (client) => {
    await client.query(
      `insert into tandem.events
         (id, workspace_id, entity_type, entity_id, lead_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, 'lead', $3, $3, $4, $5, $6, $7, $8)`,
      [newEvent.id, WORKSPACE_ID, leadId, newEvent.source, newEvent.sourceEventId, newEvent.type, JSON.stringify(newEvent.data), newEvent.occurredAt]
    );
    await client.query(
      `insert into tandem.leads (id, workspace_id, company_name, contact_phone, qualification_metric, product_tag, pipeline_status, last_event_sequence)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [leadId, WORKSPACE_ID, state.companyName, input.contactPhone.trim(), state.qualificationMetric, input.productTag.trim(), state.status, state.lastSequence]
    );
  });
  revalidatePath("/leads");
  revalidatePath("/");
  return leadId;
}

async function loadDisputeEvents(client: import("pg").PoolClient, disputeId: string): Promise<import("tandem-crm").DisputeEvent[]> {
  const result = await client.query<{
    id: string; sequence: number; event_type: string; payload: Record<string, unknown>; occurred_at: string;
    source: string; source_event_id: string; lead_id: string; payout_id: string;
  }>(
    `select id, sequence, event_type, payload, occurred_at, source, source_event_id, lead_id, payout_id
     from tandem.dispute_events where dispute_id = $1 and workspace_id = $2 order by sequence`,
    [disputeId, WORKSPACE_ID]
  );
  return result.rows.map((row) => ({
    id: row.id, sequence: Number(row.sequence), workspaceId: WORKSPACE_ID, disputeId,
    leadId: row.lead_id, payoutId: row.payout_id, source: row.source, sourceEventId: row.source_event_id,
    occurredAt: new Date(row.occurred_at).toISOString(), type: row.event_type, data: row.payload,
  })) as import("tandem-crm").DisputeEvent[];
}

async function appendDisputeEvent(
  disputeId: string,
  type: import("tandem-crm").DisputeEvent["type"],
  data: import("tandem-crm").DisputeEvent["data"]
): Promise<void> {
  const { replayDisputeEvents } = await import("tandem-crm");
  const member = await requireCurrentMember();
  await withTandemSession(pool, member.userId, async (client) => {
    const existing = await loadDisputeEvents(client, disputeId);
    if (existing.length === 0) throw new Error("dispute not found");
    const { leadId, payoutId } = existing[0];
    const nextSequence = existing[existing.length - 1].sequence + 1;
    const newEvent = {
      id: randomUUID(), sequence: nextSequence, workspaceId: WORKSPACE_ID, disputeId, leadId, payoutId,
      source: "dashboard", sourceEventId: `dashboard-${randomUUID()}`, occurredAt: new Date().toISOString(),
      type, data,
    } as import("tandem-crm").DisputeEvent;

    const state = replayDisputeEvents([...existing, newEvent], WORKSPACE_ID, disputeId);
    if (!state) throw new Error("dispute has no state after append");

    await client.query(
      `insert into tandem.dispute_events
         (id, workspace_id, dispute_id, lead_id, payout_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [newEvent.id, WORKSPACE_ID, disputeId, leadId, payoutId, newEvent.source, newEvent.sourceEventId, newEvent.type, JSON.stringify(newEvent.data), newEvent.occurredAt]
    );
    await client.query(
      `update tandem.disputes
       set status = $2, outcome = $3, resolution_note = coalesce($4, resolution_note),
           last_event_sequence = $5, updated_at = now()
       where id = $1 and workspace_id = $6`,
      [disputeId, state.status, state.outcome, type === "dispute.resolved" ? (data as { note: string }).note : null, state.lastSequence, WORKSPACE_ID]
    );
  });
  revalidatePath("/disputes");
  revalidatePath(`/disputes/${disputeId}`);
}

export async function queryDispute(disputeId: string, question: string): Promise<void> {
  if (!question.trim()) throw new Error("a question is required");
  await appendDisputeEvent(disputeId, "dispute.queried", { question: question.trim() });
}

export async function resolveDispute(disputeId: string, outcome: "upheld" | "dismissed", note: string): Promise<void> {
  if (!note.trim()) throw new Error("a resolution note is required");
  await appendDisputeEvent(disputeId, "dispute.resolved", { outcome, note: note.trim() });
}

/** Acting on an upheld dispute is a separate, explicit step from resolving
 * it (see coaster.ts and migration 011's comments) -- the operator reviews
 * the resolved dispute, picks the category-appropriate action below, and
 * this appends the matching Core event via appendLeadEvent, which already
 * validates the transition through domain.ts's reducer before writing
 * anything. Amounts are operator-entered rather than auto-recomputed from
 * a commission rule: simpler, and the reducer still rejects an amount that
 * exceeds the lead's payment either way. */
export async function executeDisputeOutcome(
  disputeId: string,
  action: "adjust" | "reinstate" | "clawback",
  amountMinor: number,
  reasonOrReleaseAt: string
): Promise<void> {
  const member = await requireCurrentMember();
  const idempotency = {
    source: "coaster-dispute",
    sourceEventId: `dispute:${disputeId}:outcome`,
  };
  const result = await withTandemSession(pool, member.userId, async (client) => {
    const result = await client.query<{ lead_id: string; payout_id: string; status: string; outcome: string | null }>(
      `select lead_id, payout_id, status, outcome from tandem.disputes
       where id = $1 and workspace_id = $2`,
      [disputeId, WORKSPACE_ID]
    );
    const row = result.rows[0];
    if (!row) throw new Error("dispute not found");
    if (row.status !== "resolved" || row.outcome !== "upheld") throw new Error("only an upheld, resolved dispute can be acted on");
    const alreadyApplied = await client.query(
      `select 1 from tandem.events
       where workspace_id = $1 and source = $2 and source_event_id = $3`,
      [WORKSPACE_ID, idempotency.source, idempotency.sourceEventId]
    );
    return { leadId: row.lead_id, payoutId: row.payout_id, alreadyApplied: (alreadyApplied.rowCount ?? 0) > 0 };
  });

  // A resolved dispute gets one explicit execution. Repeating a browser
  // submit or retrying a server action must not append a second adjustment,
  // reinstatement, or clawback for the same operator decision.
  if (result.alreadyApplied) return;
  const { leadId, payoutId } = result;

  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("amount must be a positive integer");

  if (action === "adjust") {
    await appendLeadEvent(leadId, "commission.adjusted", { payoutId, newAmountMinor: amountMinor }, idempotency);
  } else if (action === "reinstate") {
    if (!reasonOrReleaseAt.trim()) throw new Error("a release date is required to reinstate");
    await appendLeadEvent(leadId, "commission.reinstated", { payoutId, amountMinor, releaseAt: reasonOrReleaseAt }, idempotency);
  } else {
    if (!reasonOrReleaseAt.trim()) throw new Error("a reason is required to request a clawback");
    await appendLeadEvent(leadId, "commission.clawback_requested", { payoutId, amountMinor, reason: reasonOrReleaseAt }, idempotency);
  }
}

async function loadTrailEvents(client: import("pg").PoolClient, leadId: string, entryId: string): Promise<TrailEvent[]> {
  const result = await client.query<{
    id: string; sequence: number; event_type: string; payload: Record<string, unknown>; occurred_at: string;
    source: string; source_event_id: string;
  }>(
    `select id, sequence, event_type, payload, occurred_at, source, source_event_id
     from tandem.trail_events where lead_id = $1 and entry_id = $2 and workspace_id = $3 order by sequence`,
    [leadId, entryId, WORKSPACE_ID]
  );
  return result.rows.map((row) => ({
    id: row.id, sequence: Number(row.sequence), workspaceId: WORKSPACE_ID, leadId, entryId,
    source: row.source, sourceEventId: row.source_event_id,
    occurredAt: new Date(row.occurred_at).toISOString(), type: row.event_type, data: row.payload,
  })) as TrailEvent[];
}

export type TrailInput = { channel: TrailVisitChannel; confidenceRating: number; salesStage: TrailSalesStage; note: string };

function validateTrailInput(input: TrailInput): void {
  if (!trailVisitChannels.includes(input.channel)) throw new Error("invalid channel");
  if (!trailSalesStages.includes(input.salesStage)) throw new Error("invalid sales stage");
  if (!Number.isSafeInteger(input.confidenceRating) || input.confidenceRating < 1 || input.confidenceRating > 10) {
    throw new Error("confidence rating must be an integer from 1 to 10");
  }
  if (!input.note.trim()) throw new Error("a note is required");
}

export async function logTrailVisit(leadId: string, input: TrailInput): Promise<void> {
  validateTrailInput(input);
  const member = await requireCurrentMember();
  const entryId = randomUUID();
  const newEvent = {
    id: randomUUID(), sequence: 1, workspaceId: WORKSPACE_ID, leadId, entryId,
    source: "dashboard", sourceEventId: `dashboard-${randomUUID()}`, occurredAt: new Date().toISOString(),
    type: "trail.visit_logged", data: input,
  } as TrailEvent;
  const state = replayTrailEntryEvents([newEvent], WORKSPACE_ID, leadId, entryId);
  if (!state) throw new Error("trail entry has no state after logging");

  await withTandemSession(pool, member.userId, async (client) => {
    await client.query(
      `insert into tandem.trail_events
         (id, workspace_id, lead_id, entry_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [newEvent.id, WORKSPACE_ID, leadId, entryId, newEvent.source, newEvent.sourceEventId, newEvent.type, JSON.stringify(newEvent.data), newEvent.occurredAt]
    );
    await client.query(
      `insert into tandem.trail_entries
         (id, workspace_id, lead_id, channel, confidence_rating, sales_stage, note, logged_at, last_event_sequence)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [entryId, WORKSPACE_ID, leadId, state.channel, state.confidenceRating, state.salesStage, state.note, state.loggedAt, state.lastSequence]
    );
  });
  revalidatePath(`/leads/${leadId}`);
}

async function appendTrailEvent(
  leadId: string,
  entryId: string,
  type: TrailEvent["type"],
  data: TrailEvent["data"]
): Promise<void> {
  const member = await requireCurrentMember();
  await withTandemSession(pool, member.userId, async (client) => {
    const existing = await loadTrailEvents(client, leadId, entryId);
    if (existing.length === 0) throw new Error("trail entry not found");
    const nextSequence = existing[existing.length - 1].sequence + 1;
    const newEvent = {
      id: randomUUID(), sequence: nextSequence, workspaceId: WORKSPACE_ID, leadId, entryId,
      source: "dashboard", sourceEventId: `dashboard-${randomUUID()}`, occurredAt: new Date().toISOString(),
      type, data,
    } as TrailEvent;
    const state = replayTrailEntryEvents([...existing, newEvent], WORKSPACE_ID, leadId, entryId);
    if (!state) throw new Error("trail entry has no state after append");

    await client.query(
      `insert into tandem.trail_events
         (id, workspace_id, lead_id, entry_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [newEvent.id, WORKSPACE_ID, leadId, entryId, newEvent.source, newEvent.sourceEventId, newEvent.type, JSON.stringify(newEvent.data), newEvent.occurredAt]
    );
    await client.query(
      `update tandem.trail_entries
       set channel = $2, confidence_rating = $3, sales_stage = $4, note = $5,
           corrected_at = $6, retracted = $7, last_event_sequence = $8, updated_at = now()
       where id = $1 and workspace_id = $9 and lead_id = $10`,
      [entryId, state.channel, state.confidenceRating, state.salesStage, state.note, state.correctedAt, state.retracted, state.lastSequence, WORKSPACE_ID, leadId]
    );
  });
  revalidatePath(`/leads/${leadId}`);
}

export async function correctTrailEntry(leadId: string, entryId: string, input: TrailInput): Promise<void> {
  validateTrailInput(input);
  await appendTrailEvent(leadId, entryId, "trail.entry_corrected", input);
}

export async function retractTrailEntry(leadId: string, entryId: string): Promise<void> {
  await appendTrailEvent(leadId, entryId, "trail.entry_retracted", {});
}

export async function switchDemoUser(userId: string): Promise<void> {
  await setDemoUser(userId);
  revalidatePath("/");
}
