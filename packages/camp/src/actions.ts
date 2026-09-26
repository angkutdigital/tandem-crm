"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { replayLeadEvents, type TandemEvent } from "tandem-crm";
import { withTandemSession } from "tandem-crm/db";
import { getTandemCampConfig } from "./config.js";
import { requireCurrentMember } from "./queries.js";

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

/** Appends one new event to a lead's history, validated by replaying the
 * full history (existing + new) through the same reducer the engine ships,
 * then writes the event and the resulting projection row in one
 * transaction -- the "validate and append in one transaction" contract the
 * root README describes for a projection writer. */
async function appendLeadEvent(
  leadId: string,
  type: TandemEvent["type"],
  data: TandemEvent["data"],
  idempotency?: { source: string; sourceEventId: string }
): Promise<void> {
  const { pool, workspaceId } = getTandemCampConfig();
  const member = await requireCurrentMember();
  await withTandemSession(pool, member.userId, async (client) => {
    const existing = await loadLeadEvents(client, leadId);
    const nextSequence = existing.length > 0 ? existing[existing.length - 1].sequence + 1 : 1;
    const newEvent = {
      id: randomUUID(), sequence: nextSequence, workspaceId, leadId,
      source: idempotency?.source ?? "camp",
      sourceEventId: idempotency?.sourceEventId ?? `camp-${randomUUID()}`,
      occurredAt: new Date().toISOString(), type, data,
    } as TandemEvent;

    const state = replayLeadEvents([...existing, newEvent], workspaceId, leadId);
    if (!state) throw new Error("lead has no state after append");

    await client.query(
      `insert into tandem.events
         (id, workspace_id, entity_type, entity_id, lead_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, 'lead', $3, $3, $4, $5, $6, $7, $8)`,
      [newEvent.id, workspaceId, leadId, newEvent.source, newEvent.sourceEventId, newEvent.type, JSON.stringify(newEvent.data), newEvent.occurredAt]
    );
    await client.query(
      `update tandem.leads
       set pipeline_status = $2, sales_stage = $3, assignee_id = coalesce($4, assignee_id), territory_id = coalesce($5, territory_id),
           last_event_sequence = $6, updated_at = now()
       where id = $1 and workspace_id = $7`,
      [leadId, state.status, state.salesStage, state.agentId, state.territoryId, state.lastSequence, workspaceId]
    );

    if (state.commission) {
      // A payout is a rebuildable projection, just like a lead: the event
      // just appended is the source of truth, and every field the reducer
      // may have changed (not just status -- commission.adjusted changes
      // amountMinor, commission.reinstated changes releaseAt, a clawback
      // sets three more columns) must be synced in this same transaction,
      // or a view reading tandem.payouts can show a stale amount/status
      // right after an action claims it was applied. This bit an early
      // version of this function: it only synced `status`, so
      // commission.adjusted's new amount silently never reached the
      // payouts table even though the Core event was correctly recorded.
      const clawback = state.commission.clawback;
      await client.query(
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
    }
  });
  revalidatePath("/tandem-camp/payouts");
  revalidatePath("/tandem-camp/disputes");
}

export async function approveCommission(leadId: string, payoutId: string): Promise<void> {
  await appendLeadEvent(leadId, "commission.approved", { payoutId });
}

/** Executes the real transfer through the configured TandemPayoutAdapter,
 * then records commission.paid with the reference it returns. Deliberately
 * two separate steps, not one transaction spanning the network call: if
 * the transfer throws, nothing is appended and the payout stays
 * "approved" -- exactly the retryable state it needs to be in. */
export async function payCommission(
  leadId: string,
  payoutId: string,
  partnerId: string,
  amountMinor: number,
  currency: string
): Promise<void> {
  const { payoutAdapter } = getTandemCampConfig();
  if (!payoutAdapter) {
    throw new Error("tandem-camp: no payoutAdapter configured -- see the README's Adapter pattern section.");
  }
  const { payoutReference } = await payoutAdapter.executePayout({ payoutId, partnerId, amountMinor, currency });
  await appendLeadEvent(leadId, "commission.paid", { payoutId, payoutReference });
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
