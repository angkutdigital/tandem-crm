"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import {
  replayLeadEvents, replayAgentOnboardingEvents, replayTrailEntryEvents,
  qualifyLead, defaultTandemConfig, trailVisitChannels, trailSalesStages,
  type TandemEvent, type AgentOnboardingEvent, type TrailEvent, type TrailVisitChannel, type TrailSalesStage,
} from "tandem-crm";
import { withTandemSession } from "tandem-crm/db";
import { getTandemCampConfig } from "./config.js";
import { requireCurrentMember, getOnboardingSteps } from "./queries.js";

/** Mirrors examples/dashboard's createLead: qualification is computed and
 * snapshotted onto lead.created the same way any adapter would, and PIC
 * (contactName) / address are optional, stored in tandem.leads.attributes
 * (a jsonb column the schema reserves for host-defined lead fields) rather
 * than their own columns. */
export async function createLead(input: {
  companyName: string;
  contactPhone: string;
  qualificationMetric: number;
  productTag: string;
  contactName?: string;
  address?: string;
}): Promise<string> {
  const { pool, workspaceId } = getTandemCampConfig();
  const member = await requireCurrentMember();
  if (!input.companyName.trim()) throw new Error("company name is required");
  if (!input.contactPhone.trim()) throw new Error("contact phone is required");
  if (!input.productTag.trim()) throw new Error("product tag is required");

  const leadId = randomUUID();
  const qualification = qualifyLead({ qualificationMetric: input.qualificationMetric }, defaultTandemConfig);
  const newEvent = {
    id: randomUUID(), sequence: 1, workspaceId, leadId,
    source: "camp", sourceEventId: `camp-${randomUUID()}`, occurredAt: new Date().toISOString(),
    type: "lead.created",
    data: {
      companyName: input.companyName.trim(), qualificationMetric: input.qualificationMetric,
      qualification: qualification.status,
    },
  } as TandemEvent;

  const state = replayLeadEvents([newEvent], workspaceId, leadId);
  if (!state) throw new Error("lead has no state after creation");

  const attributes: Record<string, string> = {};
  if (input.contactName?.trim()) attributes.contactName = input.contactName.trim();
  if (input.address?.trim()) attributes.address = input.address.trim();

  await withTandemSession(pool, member.userId, async (client) => {
    await client.query(
      `insert into tandem.events
         (id, workspace_id, entity_type, entity_id, lead_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, 'lead', $3, $3, $4, $5, $6, $7, $8)`,
      [newEvent.id, workspaceId, leadId, newEvent.source, newEvent.sourceEventId, newEvent.type, JSON.stringify(newEvent.data), newEvent.occurredAt]
    );
    await client.query(
      `insert into tandem.leads (id, workspace_id, company_name, contact_phone, qualification_metric, product_tag, attributes, pipeline_status, last_event_sequence)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [leadId, workspaceId, state.companyName, input.contactPhone.trim(), state.qualificationMetric, input.productTag.trim(), JSON.stringify(attributes), state.status, state.lastSequence]
    );
  });
  revalidatePath("/tandem-camp/leads");
  revalidatePath("/tandem-camp");
  return leadId;
}

/** Mirrors examples/dashboard's createAgentProfile. Only creates the
 * operational profile row -- linking a real sign-in account is a separate
 * step through the host's own auth provider, same convention as the
 * dashboard's own Add agent dialog. */
export async function createAgentProfile(input: {
  displayName: string;
  externalRef?: string;
}): Promise<string> {
  const { pool, workspaceId } = getTandemCampConfig();
  const member = await requireCurrentMember();
  if (member.role !== "owner" && member.role !== "admin") {
    throw new Error("only a workspace owner or admin can add an agent profile");
  }
  const displayName = input.displayName.trim();
  const externalRef = input.externalRef?.trim() || null;
  if (!displayName) throw new Error("agent name is required");

  const agentId = randomUUID();
  await withTandemSession(pool, member.userId, (client) =>
    client.query(
      `insert into tandem.agents (id, workspace_id, display_name, external_ref)
       values ($1, $2, $3, $4)`,
      [agentId, workspaceId, displayName, externalRef]
    )
  );
  revalidatePath("/tandem-camp");
  revalidatePath("/tandem-camp/agents");
  return agentId;
}

async function loadLeadEvents(client: import("pg").PoolClient, leadId: string): Promise<TandemEvent[]> {
  const { workspaceId } = getTandemCampConfig();
  const result = await client.query<{
    id: string; sequence: number; event_type: string; payload: Record<string, unknown>; occurred_at: string;
    source: string; source_event_id: string;
  }>(
    `select id, sequence, event_type, payload, occurred_at, source, source_event_id
     from tandem.events where lead_id = $1 and workspace_id = $2 order by sequence`,
    [leadId, workspaceId]
  );
  return result.rows.map((row) => ({
    id: row.id, sequence: Number(row.sequence), workspaceId, leadId,
    source: row.source, sourceEventId: row.source_event_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    type: row.event_type, data: row.payload,
  })) as TandemEvent[];
}

type CampMember = { userId: string; role: "owner" | "admin" | "agent" };

function isWorkspaceManager(member: { role: "owner" | "admin" | "agent" }): boolean {
  return member.role === "owner" || member.role === "admin";
}

/** Approving, paying, adjusting, reinstating or clawing back a commission
 * is an operator decision, never an agent's on their own lead. This is
 * enforced here as well as in the database (migration 021) so a caller
 * gets a clear error instead of relying on a silent RLS filter. */
function requireCommissionManager(member: { role: "owner" | "admin" | "agent" }): void {
  if (!isWorkspaceManager(member)) {
    throw new Error("only a workspace owner or admin can approve, pay, or change a commission");
  }
}

/** Appends one new event to a lead's history inside an already-open
 * transaction: validated by replaying the full history (existing + new)
 * through the same reducer the engine ships, then writing the event and the
 * resulting projection rows together -- the "validate and append in one
 * transaction" contract the root README describes for a projection writer.
 *
 * The lead row is locked first, so two concurrent appends to the same lead
 * (say a double-clicked kanban drop) run one after the other instead of both
 * validating against the same history and both inserting a duplicate
 * transition, which would make the append-only log fail replay forever.
 *
 * Every projection UPDATE has its row count checked. An UPDATE that Row
 * Level Security filters out reports success with zero rows, which would
 * otherwise leave the event log and the projection silently disagreeing. */
async function appendLeadEventInTx(
  client: import("pg").PoolClient,
  member: CampMember,
  leadId: string,
  type: TandemEvent["type"],
  data: TandemEvent["data"],
  idempotency?: { source: string; sourceEventId: string }
): Promise<void> {
  const { workspaceId } = getTandemCampConfig();
  if (type.startsWith("commission.") || type.startsWith("payment.")) requireCommissionManager(member);

  const locked = await client.query(
    "select 1 from tandem.leads where id = $1 and workspace_id = $2 for update",
    [leadId, workspaceId]
  );
  if (locked.rowCount !== 1) throw new Error("lead not found");

  const existing = await loadLeadEvents(client, leadId);
  const nextSequence = existing.length > 0 ? existing[existing.length - 1].sequence + 1 : 1;
  const newEvent = {
    id: randomUUID(), sequence: nextSequence, workspaceId, leadId,
    source: idempotency?.source ?? "camp",
    sourceEventId: idempotency?.sourceEventId ?? `camp-${randomUUID()}`,
    occurredAt: new Date().toISOString(), type, data,
  } as TandemEvent;

  const previous = existing.length > 0 ? replayLeadEvents(existing, workspaceId, leadId) : null;
  const state = replayLeadEvents([...existing, newEvent], workspaceId, leadId);
  if (!state) throw new Error("lead has no state after append");
  const commissionChanged = JSON.stringify(previous?.commission ?? null) !== JSON.stringify(state.commission ?? null);
  if (commissionChanged) requireCommissionManager(member);

  // The database assigns the real sequence (one identity column shared by
  // every workspace), so read it back rather than storing the reducer's
  // locally computed guess in last_event_sequence.
  const inserted = await client.query<{ sequence: string }>(
    `insert into tandem.events
       (id, workspace_id, entity_type, entity_id, lead_id, source, source_event_id, event_type, payload, occurred_at)
     values ($1, $2, 'lead', $3, $3, $4, $5, $6, $7, $8)
     returning sequence`,
    [newEvent.id, workspaceId, leadId, newEvent.source, newEvent.sourceEventId, newEvent.type, JSON.stringify(newEvent.data), newEvent.occurredAt]
  );
  const actualSequence = Number(inserted.rows[0].sequence);

  const leadUpdate = await client.query(
    `update tandem.leads
     set pipeline_status = $2, sales_stage = $3, assignee_id = coalesce($4, assignee_id), territory_id = coalesce($5, territory_id),
         last_event_sequence = $6, updated_at = now()
     where id = $1 and workspace_id = $7`,
    [leadId, state.status, state.salesStage, state.agentId, state.territoryId, actualSequence, workspaceId]
  );
  if (leadUpdate.rowCount !== 1) throw new Error("the lead projection was not updated; this account may not modify that lead");

  if (state.commission && commissionChanged) {
    // A payout is a rebuildable projection, just like a lead: the event
    // just appended is the source of truth, and every field the reducer
    // may have changed (not just status -- commission.adjusted changes
    // amountMinor, commission.reinstated changes releaseAt, a clawback
    // sets three more columns) must be synced in this same transaction,
    // or a view reading tandem.payouts can show a stale amount/status
    // right after an action claims it was applied.
    const clawback = state.commission.clawback;
    const payoutUpdate = await client.query(
      `update tandem.payouts
       set amount_minor = $3,
           release_at = $4,
           status = $5,
           last_event_id = $6,
           approved_at = case when $5 = 'approved' then coalesce(approved_at, now()) else approved_at end,
           paid_at = case when $5 = 'paid' then coalesce(paid_at, now()) else paid_at end,
           voided_at = case when $5 = 'voided' then coalesce(voided_at, now()) else voided_at end,
           clawback_amount_minor = $7,
           clawback_reason = $8,
           clawback_requested_at = $9,
           updated_at = now()
       where id = $1 and workspace_id = $2`,
      [
        state.commission.payoutId, workspaceId, state.commission.amountMinor,
        state.commission.releaseAt, state.commission.status, newEvent.id,
        clawback?.amountMinor ?? null, clawback?.reason ?? null, clawback?.requestedAt ?? null,
      ]
    );
    if (payoutUpdate.rowCount !== 1) throw new Error("the payout projection was not updated; the payout row is missing or this account may not change it");
  }
}

async function appendLeadEvent(
  leadId: string,
  type: TandemEvent["type"],
  data: TandemEvent["data"],
  idempotency?: { source: string; sourceEventId: string }
): Promise<void> {
  const { pool } = getTandemCampConfig();
  const member = await requireCurrentMember();
  await withTandemSession(pool, member.userId, (client) =>
    appendLeadEventInTx(client, member, leadId, type, data, idempotency)
  );
  revalidatePath("/tandem-camp/payouts");
  revalidatePath("/tandem-camp/disputes");
}

export async function markLeadWon(leadId: string): Promise<void> {
  await appendLeadEvent(leadId, "conversion.confirmed", {});
}

export async function markLeadLost(leadId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new Error("a reason is required to mark a lead lost");
  await appendLeadEvent(leadId, "lead.lost", { reason });
}

/** Called when a kanban card is dragged into a new column. Not every
 * column pair is a real transition: Won -> Commission_Hold needs a
 * partner/amount/release date, Commission_Hold -> Commission_Eligible
 * needs the release date to have passed, and so on through the rest of
 * the money pipeline -- none of that exists at the moment someone drags a
 * card, so those columns are display-only destinations, not drop
 * targets. Only the two transitions a drag actually has enough
 * information for are allowed here; the UI must catch a thrown error
 * from an unsupported drop and revert the card to its original column. */
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

export async function approveCommission(leadId: string, payoutId: string): Promise<void> {
  await appendLeadEvent(leadId, "commission.approved", { payoutId });
}

/** Executes the real transfer through the configured TandemPayoutAdapter,
 * then records commission.paid with the reference it returns.
 *
 * Nothing about the transfer comes from the caller. The partner, amount and
 * currency are read from the lead's own event history (the source of truth),
 * because a server action is a public endpoint: anything the browser sends
 * can be forged. The caller must be an owner or admin, the commission must
 * belong to this lead, and it must be exactly "approved".
 *
 * The lead row stays locked from the status check until commission.paid is
 * recorded, so a double-click or two operators paying the same payout
 * cannot both pass the check. If the transfer throws, nothing is appended
 * and the payout stays "approved", the retryable state the adapter's own
 * idempotency key (derived from payoutId) needs. The tradeoff is a database
 * connection held for the duration of the transfer call. */
export async function payCommission(leadId: string, payoutId: string): Promise<void> {
  const { pool, workspaceId, payoutAdapter } = getTandemCampConfig();
  if (!payoutAdapter) {
    throw new Error("tandem-camp: no payoutAdapter configured -- see the README's Adapter pattern section.");
  }
  const member = await requireCurrentMember();
  requireCommissionManager(member);

  await withTandemSession(pool, member.userId, async (client) => {
    const locked = await client.query(
      "select 1 from tandem.leads where id = $1 and workspace_id = $2 for update",
      [leadId, workspaceId]
    );
    if (locked.rowCount !== 1) throw new Error("lead not found");

    const state = replayLeadEvents(await loadLeadEvents(client, leadId), workspaceId, leadId);
    const commission = state?.commission;
    if (!commission || commission.payoutId !== payoutId) throw new Error("that payout does not belong to this lead");
    if (commission.status !== "approved") {
      throw new Error(`this commission is ${commission.status}; only an approved commission can be paid`);
    }

    const { payoutReference } = await payoutAdapter.executePayout({
      payoutId,
      partnerId: commission.partnerId,
      amountMinor: commission.amountMinor,
      currency: commission.currency,
    });
    await appendLeadEventInTx(client, member, leadId, "commission.paid", { payoutId, payoutReference });
  });
  revalidatePath("/tandem-camp/payouts");
  revalidatePath("/tandem-camp/disputes");
}

async function loadDisputeEvents(client: import("pg").PoolClient, disputeId: string): Promise<import("tandem-crm").DisputeEvent[]> {
  const { workspaceId } = getTandemCampConfig();
  const result = await client.query<{
    id: string; sequence: number; event_type: string; payload: Record<string, unknown>; occurred_at: string;
    source: string; source_event_id: string; lead_id: string; payout_id: string;
  }>(
    `select id, sequence, event_type, payload, occurred_at, source, source_event_id, lead_id, payout_id
     from tandem.dispute_events where dispute_id = $1 and workspace_id = $2 order by sequence`,
    [disputeId, workspaceId]
  );
  return result.rows.map((row) => ({
    id: row.id, sequence: Number(row.sequence), workspaceId, disputeId,
    leadId: row.lead_id, payoutId: row.payout_id, source: row.source, sourceEventId: row.source_event_id,
    occurredAt: new Date(row.occurred_at).toISOString(), type: row.event_type, data: row.payload,
  })) as import("tandem-crm").DisputeEvent[];
}

async function appendDisputeEvent(
  disputeId: string,
  type: import("tandem-crm").DisputeEvent["type"],
  data: import("tandem-crm").DisputeEvent["data"]
): Promise<void> {
  const { pool, workspaceId } = getTandemCampConfig();
  const { replayDisputeEvents } = await import("tandem-crm");
  const member = await requireCurrentMember();
  if (type !== "dispute.opened") requireCommissionManager(member);
  await withTandemSession(pool, member.userId, async (client) => {
    const existing = await loadDisputeEvents(client, disputeId);
    if (existing.length === 0) throw new Error("dispute not found");
    const { leadId, payoutId } = existing[0];
    const nextSequence = existing[existing.length - 1].sequence + 1;
    const newEvent = {
      id: randomUUID(), sequence: nextSequence, workspaceId, disputeId, leadId, payoutId,
      source: "camp", sourceEventId: `camp-${randomUUID()}`, occurredAt: new Date().toISOString(),
      type, data,
    } as import("tandem-crm").DisputeEvent;

    const state = replayDisputeEvents([...existing, newEvent], workspaceId, disputeId);
    if (!state) throw new Error("dispute has no state after append");

    await client.query(
      `insert into tandem.dispute_events
         (id, workspace_id, dispute_id, lead_id, payout_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [newEvent.id, workspaceId, disputeId, leadId, payoutId, newEvent.source, newEvent.sourceEventId, newEvent.type, JSON.stringify(newEvent.data), newEvent.occurredAt]
    );
    await client.query(
      `update tandem.disputes
       set status = $2, outcome = $3, resolution_note = coalesce($4, resolution_note),
           last_event_sequence = $5, updated_at = now()
       where id = $1 and workspace_id = $6`,
      [disputeId, state.status, state.outcome, type === "dispute.resolved" ? (data as { note: string }).note : null, state.lastSequence, workspaceId]
    );
  });
  revalidatePath("/tandem-camp/disputes");
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
 * it -- the operator reviews the resolved dispute, picks the
 * category-appropriate action below, and this appends the matching
 * Terrain event via appendLeadEvent, which already validates the
 * transition through domain.ts's reducer before writing anything. Amounts
 * are operator-entered rather than auto-recomputed from a commission
 * rule: simpler, and the reducer still rejects an amount that exceeds the
 * lead's payment either way. */
export async function executeDisputeOutcome(
  disputeId: string,
  action: "adjust" | "reinstate" | "clawback",
  amountMinor: number,
  reasonOrReleaseAt: string
): Promise<void> {
  const { pool, workspaceId } = getTandemCampConfig();
  const member = await requireCurrentMember();
  requireCommissionManager(member);
  const idempotency = {
    source: "belay-dispute",
    sourceEventId: `dispute:${disputeId}:outcome`,
  };
  const result = await withTandemSession(pool, member.userId, async (client) => {
    const result = await client.query<{ lead_id: string; payout_id: string; status: string; outcome: string | null }>(
      `select lead_id, payout_id, status, outcome from tandem.disputes
       where id = $1 and workspace_id = $2`,
      [disputeId, workspaceId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("dispute not found");
    if (row.status !== "resolved" || row.outcome !== "upheld") throw new Error("only an upheld, resolved dispute can be acted on");
    const alreadyApplied = await client.query(
      `select 1 from tandem.events
       where workspace_id = $1 and source = $2 and source_event_id = $3`,
      [workspaceId, idempotency.source, idempotency.sourceEventId]
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
  revalidatePath("/tandem-camp/disputes");
}

function requireWorkspaceManager(member: { role: "owner" | "admin" | "agent" }): void {
  if (member.role !== "owner" && member.role !== "admin") {
    throw new Error("only a workspace owner or admin can change workspace setup");
  }
}

async function loadAgentEvents(client: import("pg").PoolClient, agentId: string): Promise<AgentOnboardingEvent[]> {
  const { workspaceId } = getTandemCampConfig();
  const result = await client.query<{
    id: string; sequence: number; event_type: string; payload: Record<string, unknown>; occurred_at: string;
    source: string; source_event_id: string;
  }>(
    `select id, sequence, event_type, payload, occurred_at, source, source_event_id
     from tandem.agent_events where agent_id = $1 and workspace_id = $2 order by sequence`,
    [agentId, workspaceId]
  );
  return result.rows.map((row) => ({
    id: row.id, sequence: Number(row.sequence), workspaceId, agentId,
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
  const { pool, workspaceId } = getTandemCampConfig();
  const member = await requireCurrentMember();
  await withTandemSession(pool, member.userId, async (client) => {
    const existing = await loadAgentEvents(client, agentId);
    const nextSequence = existing.length > 0 ? existing[existing.length - 1].sequence + 1 : 1;
    const newEvent = {
      id: randomUUID(), sequence: nextSequence, workspaceId, agentId,
      source: "camp", sourceEventId: `camp-${randomUUID()}`, occurredAt: new Date().toISOString(),
      type, data,
    } as AgentOnboardingEvent;

    const state = replayAgentOnboardingEvents([...existing, newEvent], workspaceId, agentId);

    await client.query(
      `insert into tandem.agent_events
         (id, workspace_id, agent_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [newEvent.id, workspaceId, agentId, newEvent.source, newEvent.sourceEventId, newEvent.type, JSON.stringify(newEvent.data), newEvent.occurredAt]
    );
    await client.query(
      `insert into tandem.agent_onboarding_status (workspace_id, agent_id, started_at, certified_at, last_event_sequence)
       values ($1, $2, $3, $4, $5)
       on conflict (workspace_id, agent_id) do update
         set started_at = excluded.started_at, certified_at = excluded.certified_at,
             last_event_sequence = excluded.last_event_sequence, updated_at = now()`,
      [workspaceId, agentId, state?.startedAt ?? null, state?.certifiedAt ?? null, state?.lastSequence ?? null]
    );
  });
  revalidatePath("/tandem-camp/agents");
}

export async function completeOnboardingStep(agentId: string, stepCode: string, alreadyStarted: boolean): Promise<void> {
  if (!alreadyStarted) await appendOnboardingEvent(agentId, "onboarding.started", {});
  await appendOnboardingEvent(agentId, "onboarding.step_completed", { stepCode });
}

/** Certifying is the implementing application's call, same as any gate
 * Tandem tracks but doesn't enforce -- this only requires what the reducer
 * itself requires (onboarding started, not already certified), but the UI
 * that calls this only enables the button once every required step is
 * complete, applying isAgentCurrentlyCertified() as the actual business
 * policy. */
export async function certifyAgent(agentId: string): Promise<void> {
  const { pool, workspaceId } = getTandemCampConfig();
  const member = await requireCurrentMember();
  const requiredSteps = (await getOnboardingSteps(member.userId)).filter((s) => s.required);
  const state = await withTandemSession(pool, member.userId, async (client) => {
    const events = await loadAgentEvents(client, agentId);
    return events.length > 0 ? replayAgentOnboardingEvents(events, workspaceId, agentId) : null;
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

export async function assignAgentToTerritory(agentId: string, territoryId: string): Promise<void> {
  const { pool, workspaceId } = getTandemCampConfig();
  const member = await requireCurrentMember();
  requireWorkspaceManager(member);
  await withTandemSession(pool, member.userId, (client) =>
    client.query(
      `insert into tandem.agent_territories (workspace_id, agent_id, territory_id)
       values ($1, $2, $3)
       on conflict do nothing`,
      [workspaceId, agentId, territoryId]
    )
  );
  revalidatePath("/tandem-camp/agents");
}

/** Keeps the lead's own promoted sales stage (queryable, drives the funnel
 * view) in sync with whatever an agent just logged in Trail, in the same
 * transaction as the trail write -- mirrors examples/dashboard's own
 * syncLeadSalesStage. A no-op append is skipped rather than growing the
 * Core event log with an event that changes nothing. Takes an
 * already-open client (unlike the top-of-file appendLeadEvent, which
 * opens its own session) so this can share one transaction with the
 * trail_events/trail_entries write it always accompanies. */
async function syncLeadSalesStage(
  client: import("pg").PoolClient,
  member: CampMember,
  leadId: string,
  salesStage: TrailSalesStage
): Promise<void> {
  const { workspaceId } = getTandemCampConfig();
  const leadState = replayLeadEvents(await loadLeadEvents(client, leadId), workspaceId, leadId);
  if (!leadState || leadState.salesStage === salesStage) return;
  await appendLeadEventInTx(client, member, leadId, "lead.stage_changed", { salesStage });
}

export type TrailInput = {
  channel: TrailVisitChannel;
  confidenceRating: number;
  salesStage: TrailSalesStage;
  note?: string;
  challenges?: string;
  authority?: string;
  budget?: string;
  prioritization?: string;
};

/** Mirrors src/trail.ts's own validateFields and examples/dashboard's
 * validateTrailInput exactly -- a clearer, earlier error for Camp's form,
 * not a stricter rule than the domain reducer already enforces. CHAMP
 * fields stay optional here too, for the same backward-compatibility
 * reason: the reducer itself can never require them (see trail.ts), so
 * this action-layer check can't either without lying about what the
 * domain layer actually accepts. */
function validateTrailInput(input: TrailInput): void {
  if (!trailVisitChannels.includes(input.channel)) throw new Error("invalid channel");
  if (!trailSalesStages.includes(input.salesStage)) throw new Error("invalid sales stage");
  if (!Number.isSafeInteger(input.confidenceRating) || input.confidenceRating < 1 || input.confidenceRating > 10) {
    throw new Error("confidence rating must be an integer from 1 to 10");
  }
  const hasContent = [input.note, input.challenges, input.authority, input.budget, input.prioritization]
    .some((field) => field?.trim());
  if (!hasContent) throw new Error("at least one of note, challenges, authority, budget, or prioritization is required");
}

export async function logTrailVisit(leadId: string, input: TrailInput): Promise<void> {
  validateTrailInput(input);
  const { pool, workspaceId } = getTandemCampConfig();
  const member = await requireCurrentMember();
  const entryId = randomUUID();
  const newEvent = {
    id: randomUUID(), sequence: 1, workspaceId, leadId, entryId,
    source: "camp", sourceEventId: `camp-${randomUUID()}`, occurredAt: new Date().toISOString(),
    type: "trail.visit_logged", data: input,
  } as TrailEvent;
  const state = replayTrailEntryEvents([newEvent], workspaceId, leadId, entryId);
  if (!state) throw new Error("trail entry has no state after logging");

  await withTandemSession(pool, member.userId, async (client) => {
    await client.query(
      `insert into tandem.trail_events
         (id, workspace_id, lead_id, entry_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [newEvent.id, workspaceId, leadId, entryId, newEvent.source, newEvent.sourceEventId, newEvent.type, JSON.stringify(newEvent.data), newEvent.occurredAt]
    );
    await client.query(
      `insert into tandem.trail_entries
         (id, workspace_id, lead_id, channel, confidence_rating, sales_stage, note, challenges, authority, budget, prioritization, logged_at, last_event_sequence)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [entryId, workspaceId, leadId, state.channel, state.confidenceRating, state.salesStage, state.note,
        state.challenges, state.authority, state.budget, state.prioritization, state.loggedAt, state.lastSequence]
    );
    await syncLeadSalesStage(client, member, leadId, state.salesStage);
  });
  revalidatePath(`/tandem-camp/leads/${leadId}`);
}

async function loadTrailEvents(client: import("pg").PoolClient, leadId: string, entryId: string): Promise<TrailEvent[]> {
  const { workspaceId } = getTandemCampConfig();
  const result = await client.query<{
    id: string; sequence: number; event_type: string; payload: Record<string, unknown>; occurred_at: string;
    source: string; source_event_id: string;
  }>(
    `select id, sequence, event_type, payload, occurred_at, source, source_event_id
     from tandem.trail_events where lead_id = $1 and entry_id = $2 and workspace_id = $3 order by sequence`,
    [leadId, entryId, workspaceId]
  );
  return result.rows.map((row) => ({
    id: row.id, sequence: Number(row.sequence), workspaceId, leadId, entryId,
    source: row.source, sourceEventId: row.source_event_id,
    occurredAt: new Date(row.occurred_at).toISOString(), type: row.event_type, data: row.payload,
  })) as TrailEvent[];
}

async function appendTrailEvent(
  leadId: string,
  entryId: string,
  type: TrailEvent["type"],
  data: TrailEvent["data"]
): Promise<void> {
  const { pool, workspaceId } = getTandemCampConfig();
  const member = await requireCurrentMember();
  await withTandemSession(pool, member.userId, async (client) => {
    const existing = await loadTrailEvents(client, leadId, entryId);
    if (existing.length === 0) throw new Error("trail entry not found");
    const nextSequence = existing[existing.length - 1].sequence + 1;
    const newEvent = {
      id: randomUUID(), sequence: nextSequence, workspaceId, leadId, entryId,
      source: "camp", sourceEventId: `camp-${randomUUID()}`, occurredAt: new Date().toISOString(),
      type, data,
    } as TrailEvent;
    const state = replayTrailEntryEvents([...existing, newEvent], workspaceId, leadId, entryId);
    if (!state) throw new Error("trail entry has no state after append");

    await client.query(
      `insert into tandem.trail_events
         (id, workspace_id, lead_id, entry_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [newEvent.id, workspaceId, leadId, entryId, newEvent.source, newEvent.sourceEventId, newEvent.type, JSON.stringify(newEvent.data), newEvent.occurredAt]
    );
    await client.query(
      `update tandem.trail_entries
       set channel = $2, confidence_rating = $3, sales_stage = $4, note = $5,
           challenges = $6, authority = $7, budget = $8, prioritization = $9,
           corrected_at = $10, retracted = $11, last_event_sequence = $12, updated_at = now()
       where id = $1 and workspace_id = $13 and lead_id = $14`,
      [entryId, state.channel, state.confidenceRating, state.salesStage, state.note,
        state.challenges, state.authority, state.budget, state.prioritization,
        state.correctedAt, state.retracted, state.lastSequence, workspaceId, leadId]
    );
    if (!state.retracted) await syncLeadSalesStage(client, member, leadId, state.salesStage);
  });
  revalidatePath(`/tandem-camp/leads/${leadId}`);
}

export async function correctTrailEntry(leadId: string, entryId: string, input: TrailInput): Promise<void> {
  validateTrailInput(input);
  await appendTrailEvent(leadId, entryId, "trail.entry_corrected", input);
}

export async function retractTrailEntry(leadId: string, entryId: string): Promise<void> {
  await appendTrailEvent(leadId, entryId, "trail.entry_retracted", {});
}

export async function createOnboardingStep(input: { code: string; label: string; required: boolean }): Promise<void> {
  const { pool, workspaceId } = getTandemCampConfig();
  const member = await requireCurrentMember();
  requireWorkspaceManager(member);
  const code = input.code.trim().toLowerCase();
  const label = input.label.trim();
  if (!/^[a-z][a-z0-9_]*$/.test(code)) {
    throw new Error("step code must start with a letter and use lowercase letters, numbers, or underscores");
  }
  if (!label) throw new Error("step label is required");

  await withTandemSession(pool, member.userId, async (client) => {
    const order = await client.query<{ next_order: number }>(
      "select coalesce(max(sort_order), -1) + 1 as next_order from tandem.onboarding_steps where workspace_id = $1",
      [workspaceId]
    );
    await client.query(
      `insert into tandem.onboarding_steps (workspace_id, code, label, required, sort_order)
       values ($1, $2, $3, $4, $5)`,
      [workspaceId, code, label, input.required, order.rows[0].next_order]
    );
  });
  revalidatePath("/tandem-camp/agents");
  revalidatePath("/tandem-camp/settings/setup");
}

export async function createTerritory(input: { name: string; code: string }): Promise<void> {
  const { pool, workspaceId } = getTandemCampConfig();
  const member = await requireCurrentMember();
  requireWorkspaceManager(member);
  const name = input.name.trim();
  const code = input.code.trim().toUpperCase();
  if (!name) throw new Error("territory name is required");
  if (!/^[A-Z0-9_-]+$/.test(code)) throw new Error("territory code must use uppercase letters, numbers, hyphens, or underscores");

  await withTandemSession(pool, member.userId, (client) =>
    client.query(
      `insert into tandem.territories (workspace_id, name, code)
       values ($1, $2, $3)`,
      [workspaceId, name, code]
    )
  );
  revalidatePath("/tandem-camp/settings/setup");
  revalidatePath("/tandem-camp/settings/waypoint");
}

export async function createCommissionRule(input: {
  productTag: string;
  currency: string;
  basisPoints: number;
  holdDays: number;
}): Promise<void> {
  const { pool, workspaceId } = getTandemCampConfig();
  const member = await requireCurrentMember();
  requireWorkspaceManager(member);
  const productTag = input.productTag.trim();
  const currency = input.currency.trim().toUpperCase();
  if (!productTag) throw new Error("product tag is required");
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a three-letter ISO code, for example MYR");
  if (!Number.isSafeInteger(input.basisPoints) || input.basisPoints < 0 || input.basisPoints > 10_000) {
    throw new Error("commission rate must be between 0 and 10,000 basis points");
  }
  if (!Number.isSafeInteger(input.holdDays) || input.holdDays < 0) {
    throw new Error("hold days must be a whole number of zero or more");
  }

  await withTandemSession(pool, member.userId, (client) =>
    client.query(
      `insert into tandem.commission_rules
         (workspace_id, product_tag, currency, basis_points, hold_days)
       values ($1, $2, $3, $4, $5)`,
      [workspaceId, productTag, currency, input.basisPoints, input.holdDays]
    )
  );
  revalidatePath("/tandem-camp/settings/setup");
}

/** Links a user the host has already authenticated to one operational agent
 * profile. This never creates credentials or changes a person's workspace
 * privilege: managers may only add an agent membership, and an existing
 * membership is rejected rather than overwritten. */
export async function linkExistingUserToAgent(input: { userId: string; agentId: string }): Promise<void> {
  const { pool, workspaceId } = getTandemCampConfig();
  const member = await requireCurrentMember();
  requireWorkspaceManager(member);
  const userId = input.userId.trim();
  const agentId = input.agentId.trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(userId)) throw new Error("host user ID must be a UUID from your verified auth system");
  if (!uuid.test(agentId)) throw new Error("select a valid agent profile");

  await withTandemSession(pool, member.userId, async (client) => {
    const agent = await client.query(
      "select id from tandem.agents where id = $1 and workspace_id = $2",
      [agentId, workspaceId]
    );
    if (agent.rowCount !== 1) throw new Error("agent profile was not found in this workspace");
    const existing = await client.query(
      "select id from tandem.members where workspace_id = $1 and user_id = $2",
      [workspaceId, userId]
    );
    if (existing.rowCount !== 0) throw new Error("this host account is already linked to this workspace");
    await client.query(
      `insert into tandem.members (workspace_id, user_id, role, agent_id)
       values ($1, $2, 'agent', $3)`,
      [workspaceId, userId, agentId]
    );
  });
  revalidatePath("/tandem-camp/settings/setup");
}

export async function setWaypointStrategy(strategy: "round_robin" | "least_loaded" | "manual"): Promise<void> {
  const { pool, workspaceId } = getTandemCampConfig();
  const member = await requireCurrentMember();
  await withTandemSession(pool, member.userId, (client) =>
    client.query(
      `insert into tandem.waypoint_settings (workspace_id, strategy, updated_at) values ($1, $2, now())
       on conflict (workspace_id) do update set strategy = excluded.strategy, updated_at = now()`,
      [workspaceId, strategy]
    )
  );
  revalidatePath("/tandem-camp/settings/waypoint");
}
