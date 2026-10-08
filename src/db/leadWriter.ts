import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { replayLeadEvents, type CommissionState, type LeadState, type TandemEvent } from "../domain.js";
import { planPartnerDeactivation, planPaymentCommission, type NewPayment, type PartnerStatus, type PaymentCommissionPlan } from "../commissions.js";
import type { TandemConfig } from "../tandem.config.js";

/**
 * The one place Tandem appends lead events and keeps the lead and payout
 * projections in step with them. Every rule here came out of the 0.1
 * pre-release audit:
 *
 * - The lead row is locked first, so two writers on one lead run one after
 *   the other instead of both validating against the same history.
 * - The full history plus the new events is replayed through the reducer
 *   before anything is written, so an invalid transition never reaches the
 *   log.
 * - The real database sequence is read back with `returning sequence`.
 * - Every projection update checks its row count, so an update that row
 *   level security filtered out fails loudly instead of leaving the log
 *   and the projection disagreeing.
 * - The "tandem-engine" source is reserved for the scheduled release job.
 *
 * Call it inside a transaction (withTandemSession). It never commits.
 */

export type TandemActor = { role: "owner" | "admin" | "agent" };

export type NewLeadEvent = {
  [K in TandemEvent["type"]]: {
    type: K;
    data: Extract<TandemEvent, { type: K }>["data"];
    /** Lowercase, trimmed. Defaults to `defaultSource`. */
    source?: string;
    /** Makes a retry harmless: an event whose source and sourceEventId are
     * already in this lead's history, with the same type and data, is
     * skipped. Defaults to a random id. */
    sourceEventId?: string;
    /** Defaults to now. */
    occurredAt?: string;
  };
}[TandemEvent["type"]];

/** The only lead events a non-admin may append (matches migration 021). */
export const AGENT_LEAD_EVENT_TYPES: readonly TandemEvent["type"][] = ["lead.lost", "lead.stage_changed", "conversion.confirmed"];
const RESERVED_SOURCE = "tandem-engine";
const DAY_MS = 86_400_000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function loadLeadEvents(client: PoolClient, workspaceId: string, leadId: string): Promise<TandemEvent[]> {
  const result = await client.query<{
    id: string; sequence: string; event_type: string; payload: Record<string, unknown>; occurred_at: Date | string;
    source: string; source_event_id: string;
  }>(
    `select id, sequence, event_type, payload, occurred_at, source, source_event_id
     from tandem.events where workspace_id = $1 and lead_id = $2 order by sequence`,
    [workspaceId, leadId]
  );
  return result.rows.map((row) => ({
    id: row.id, sequence: Number(row.sequence), workspaceId, leadId,
    source: row.source, sourceEventId: row.source_event_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    type: row.event_type, data: row.payload,
  })) as TandemEvent[];
}

/** Locks the lead row for the rest of the transaction. */
export async function lockLead(client: PoolClient, workspaceId: string, leadId: string): Promise<void> {
  const locked = await client.query("select 1 from tandem.leads where id = $1 and workspace_id = $2 for update", [leadId, workspaceId]);
  if (locked.rowCount !== 1) throw new Error("lead not found");
}

/** Replays a lead's whole history under a lock. */
export async function loadLeadState(client: PoolClient, workspaceId: string, leadId: string): Promise<LeadState | null> {
  await lockLead(client, workspaceId, leadId);
  const events = await loadLeadEvents(client, workspaceId, leadId);
  return events.length > 0 ? replayLeadEvents(events, workspaceId, leadId) : null;
}

function isManager(actor: TandemActor): boolean {
  return actor.role === "owner" || actor.role === "admin";
}

function holdDays(line: CommissionState, confirmedAt: string): number {
  return Math.max(0, Math.floor((Date.parse(line.releaseAt) - Date.parse(confirmedAt)) / DAY_MS));
}

export type AppendResult = {
  state: LeadState;
  appended: { id: string; sequence: number; type: TandemEvent["type"] }[];
  /** Exact retries that were already in the history. */
  skipped: number;
};

export async function appendLeadEvents(client: PoolClient, input: {
  workspaceId: string;
  leadId: string;
  events: readonly NewLeadEvent[];
  /** When given, the agent rules are applied here as well as in the
   * database, so the caller gets a clear error. */
  actor?: TandemActor;
  defaultSource?: string;
}): Promise<AppendResult> {
  const { workspaceId, leadId } = input;
  await lockLead(client, workspaceId, leadId);
  const existing = await loadLeadEvents(client, workspaceId, leadId);
  const previous = existing.length > 0 ? replayLeadEvents(existing, workspaceId, leadId) : null;

  const pending: TandemEvent[] = [];
  let skipped = 0;
  let nextSequence = existing.length > 0 ? existing[existing.length - 1].sequence + 1 : 1;
  for (const e of input.events) {
    const source = (e.source ?? input.defaultSource ?? "app").trim().toLowerCase();
    if (!source) throw new Error("source must not be empty");
    if (source === RESERVED_SOURCE) throw new Error(`the "${RESERVED_SOURCE}" source is reserved for the scheduled release job`);
    if (input.actor && !isManager(input.actor) && !AGENT_LEAD_EVENT_TYPES.includes(e.type)) {
      throw new Error(`only a workspace owner or admin can append ${e.type}`);
    }
    const sourceEventId = (e.sourceEventId ?? `${source}-${randomUUID()}`).trim();
    const retry = [...existing, ...pending].find((x) => x.source === source && x.sourceEventId === sourceEventId);
    if (retry) {
      if (retry.type !== e.type || canonical(retry.data) !== canonical(e.data)) {
        throw new Error(`source event ${source}/${sourceEventId} was already recorded with different content`);
      }
      skipped += 1;
      continue;
    }
    pending.push({
      id: randomUUID(), sequence: nextSequence++, workspaceId, leadId, source, sourceEventId,
      occurredAt: e.occurredAt ?? new Date().toISOString(), type: e.type, data: e.data,
    } as TandemEvent);
  }

  if (pending.length === 0) {
    if (!previous) throw new Error("lead has no history");
    return { state: previous, appended: [], skipped };
  }

  // Replay after each new event, so every line change is attributed to the
  // exact event that caused it (the payout ledger is keyed by event).
  const states: (LeadState | null)[] = [previous];
  for (let i = 0; i < pending.length; i++) {
    states.push(replayLeadEvents([...existing, ...pending.slice(0, i + 1)], workspaceId, leadId));
  }
  const state = states[states.length - 1];
  if (!state) throw new Error("lead has no state after append");

  const linesBefore = new Map((previous?.commissions ?? []).map((l) => [l.payoutId, l]));
  if (input.actor && !isManager(input.actor)) {
    const changed = state.commissions.length !== linesBefore.size
      || state.commissions.some((l) => canonical(l) !== canonical(linesBefore.get(l.payoutId)));
    if (changed) throw new Error("only a workspace owner or admin can change a commission");
  }

  const appended: AppendResult["appended"] = [];
  for (const event of pending) {
    const inserted = await client.query<{ sequence: string }>(
      `insert into tandem.events
         (id, workspace_id, entity_type, entity_id, lead_id, source, source_event_id, event_type, payload, occurred_at)
       values ($1, $2, 'lead', $3, $3, $4, $5, $6, $7, $8)
       returning sequence`,
      [event.id, workspaceId, leadId, event.source, event.sourceEventId, event.type, JSON.stringify(event.data), event.occurredAt]
    );
    appended.push({ id: event.id, sequence: Number(inserted.rows[0].sequence), type: event.type });
  }

  const leadUpdate = await client.query(
    `update tandem.leads
     set pipeline_status = $3, sales_stage = $4,
         assignee_id = coalesce($5, assignee_id), territory_id = coalesce($6, territory_id),
         last_event_sequence = $7, updated_at = now()
     where id = $1 and workspace_id = $2`,
    [leadId, workspaceId, state.status, state.salesStage, state.agentId, state.territoryId, appended[appended.length - 1].sequence]
  );
  if (leadUpdate.rowCount !== 1) throw new Error("the lead projection was not updated; this account may not modify that lead");

  // Which event last touched each line, and which events moved its status.
  const lastEventFor = new Map<string, string>();
  const statusMoves: { payoutId: string; eventId: string; from: string | null; to: string }[] = [];
  for (let i = 0; i < pending.length; i++) {
    const before = new Map((states[i]?.commissions ?? []).map((l) => [l.payoutId, l]));
    let movesInEvent = 0;
    for (const line of states[i + 1]?.commissions ?? []) {
      const old = before.get(line.payoutId);
      if (old && canonical(old) === canonical(line)) continue;
      lastEventFor.set(line.payoutId, pending[i].id);
      if (!old || old.status !== line.status) {
        movesInEvent += 1;
        statusMoves.push({ payoutId: line.payoutId, eventId: pending[i].id, from: old?.status ?? null, to: line.status });
      }
    }
    if (movesInEvent > 1) throw new Error("internal: one event moved more than one commission line");
  }

  for (const line of state.commissions) {
    const eventId = lastEventFor.get(line.payoutId);
    if (!eventId) continue;
    const payment = state.payments.find((p) => p.paymentId === line.paymentId);
    if (!payment) throw new Error("internal: commission line without a payment");
    const clawback = line.clawback;
    const values = [
      line.payoutId, workspaceId, leadId, line.partnerId, line.amountMinor, line.currency, holdDays(line, payment.confirmedAt),
      payment.confirmedAt, line.releaseAt, line.status, eventId, line.paymentId, line.beneficiary, line.originalPartnerId,
      line.beneficiaryReason, line.basisPoints, line.customerAgeMonths,
      clawback?.amountMinor ?? null, clawback?.reason ?? null, clawback?.requestedAt ?? null, clawback?.recoveredMinor ?? 0,
    ];
    if (!linesBefore.has(line.payoutId)) {
      await client.query(
        `insert into tandem.payouts
           (id, workspace_id, lead_id, partner_id, amount_minor, currency, hold_days, payment_confirmed_at, release_at, status,
            last_event_id, payment_id, beneficiary, original_partner_id, beneficiary_reason, basis_points, customer_age_months,
            clawback_amount_minor, clawback_reason, clawback_requested_at, clawback_recovered_minor)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
        values
      );
    } else {
      const updated = await client.query(
        `update tandem.payouts
         set partner_id = $4, amount_minor = $5, currency = $6, hold_days = $7, payment_confirmed_at = $8, release_at = $9,
             status = $10, last_event_id = $11, payment_id = coalesce(payment_id, $12), beneficiary = $13,
             original_partner_id = $14, beneficiary_reason = $15, basis_points = coalesce($16, basis_points),
             customer_age_months = coalesce($17, customer_age_months),
             clawback_amount_minor = $18, clawback_reason = $19, clawback_requested_at = $20, clawback_recovered_minor = $21,
             approved_at = case when $10 = 'approved' then coalesce(approved_at, now()) else approved_at end,
             paid_at = case when $10 = 'paid' then coalesce(paid_at, now()) else paid_at end,
             voided_at = case when $10 = 'voided' then coalesce(voided_at, now()) else voided_at end,
             updated_at = now()
         where id = $1 and workspace_id = $2 and lead_id = $3`,
        values
      );
      if (updated.rowCount !== 1) throw new Error("the payout projection was not updated; the payout row is missing or this account may not change it");
    }
  }

  for (const move of statusMoves) {
    await client.query(
      `insert into tandem.payout_ledger (workspace_id, payout_id, event_id, from_status, to_status) values ($1, $2, $3, $4, $5)`,
      [workspaceId, move.payoutId, move.eventId, move.from, move.to]
    );
  }

  return { state, appended, skipped };
}

/**
 * The webhook entry point for one incoming payment: records it and its
 * commission line (or forfeit) together. The partner's status is read
 * after the lead lock, so a payment racing a partner deactivation always
 * ends with the policy result. A payment id already on the lead returns
 * `alreadyRecorded: true` and writes nothing.
 */
export async function recordPayment(client: PoolClient, input: {
  workspaceId: string;
  leadId: string;
  payment: NewPayment;
  config: TandemConfig;
  /** Reads the partner's current status from the host's own records. */
  partnerStatus: (partnerId: string) => Promise<PartnerStatus> | PartnerStatus;
  source: string;
  actor?: TandemActor;
  basisPoints?: number;
  holdDays?: number;
  payoutId?: string;
}): Promise<{ alreadyRecorded: boolean; state: LeadState; plan: PaymentCommissionPlan | null }> {
  const { workspaceId, leadId, payment } = input;
  if (!payment.paymentId?.trim()) throw new Error("paymentId is required");
  const state = await loadLeadState(client, workspaceId, leadId);
  if (!state) throw new Error("lead has no history");
  if (state.payments.some((p) => p.paymentId === payment.paymentId)) return { alreadyRecorded: true, state, plan: null };
  const partner = state.partnerId ? await input.partnerStatus(state.partnerId) : null;
  const plan = planPaymentCommission({
    lead: state, payment, partner, config: input.config, payoutId: input.payoutId ?? randomUUID(),
    basisPoints: input.basisPoints, holdDays: input.holdDays,
  });
  const events: NewLeadEvent[] = [{
    type: "payment.confirmed",
    data: { paymentId: payment.paymentId, amountMinor: payment.amountMinor, currency: payment.currency },
    occurredAt: payment.confirmedAt, source: input.source, sourceEventId: `payment:${payment.paymentId}`,
  }];
  if (plan.kind === "hold") {
    events.push({ type: "commission.held", data: plan.data, occurredAt: payment.confirmedAt, source: input.source, sourceEventId: `payment:${payment.paymentId}:commission` });
  } else if (plan.kind === "forfeit") {
    events.push({ type: "commission.forfeited", data: plan.data, occurredAt: payment.confirmedAt, source: input.source, sourceEventId: `payment:${payment.paymentId}:commission` });
  }
  const result = await appendLeadEvents(client, { workspaceId, leadId, events, actor: input.actor });
  return { alreadyRecorded: false, state: result.state, plan };
}

/** Records a full or partial refund of one payment. `refundId` (the
 * provider's refund id) makes a retried webhook harmless. */
export async function recordRefund(client: PoolClient, input: {
  workspaceId: string;
  leadId: string;
  paymentId: string;
  refundId: string;
  amountMinor: number;
  reason: string;
  source: string;
  occurredAt?: string;
  actor?: TandemActor;
}): Promise<AppendResult> {
  if (!input.refundId.trim()) throw new Error("refundId is required");
  return appendLeadEvents(client, {
    workspaceId: input.workspaceId, leadId: input.leadId, actor: input.actor,
    events: [{
      type: "payment.refunded",
      data: { paymentId: input.paymentId, amountMinor: input.amountMinor, reason: input.reason },
      occurredAt: input.occurredAt, source: input.source, sourceEventId: `refund:${input.refundId}`,
    }],
  });
}

/**
 * Applies the workspace's heldLines policy to every lead with an unpaid
 * line still owed to this partner. Commit the host's own "partner is
 * inactive" change before calling this, so payments that arrive during the
 * sweep already see the partner as inactive. Leads are locked one at a time
 * in id order. Safe to run again: lines already moved are not planned twice.
 */
export async function deactivatePartner(client: PoolClient, input: {
  workspaceId: string;
  partnerId: string;
  config: TandemConfig;
  reason?: string;
  actor?: TandemActor;
  source?: string;
}): Promise<{ leadsChanged: number; eventsAppended: number }> {
  const leads = await client.query<{ lead_id: string }>(
    `select distinct lead_id from tandem.payouts
     where workspace_id = $1 and partner_id = $2 and beneficiary = 'partner' and status in ('held', 'eligible', 'approved')
     order by lead_id`,
    [input.workspaceId, input.partnerId]
  );
  let leadsChanged = 0, eventsAppended = 0;
  const source = input.source ?? "partner-deactivation";
  // One id per sweep. A line voided by one deactivation, reinstated, then
  // voided by a later one must not look like a retry of the first.
  const sweepId = randomUUID();
  for (const { lead_id: leadId } of leads.rows) {
    const state = await loadLeadState(client, input.workspaceId, leadId);
    if (!state) continue;
    const [plan] = planPartnerDeactivation({ leads: [state], partnerId: input.partnerId, config: input.config, reason: input.reason });
    if (!plan) continue;
    const result = await appendLeadEvents(client, {
      workspaceId: input.workspaceId, leadId, actor: input.actor,
      events: plan.events.map((e) => ({ ...e, source, sourceEventId: `${sweepId}:${e.type}:${e.data.payoutId}` })),
    });
    leadsChanged += 1;
    eventsAppended += result.appended.length;
  }
  return { leadsChanged, eventsAppended };
}
