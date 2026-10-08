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
  type TandemPayoutAdapter,
} from "tandem-crm";
import { withTandemSession, appendLeadEvents, loadLeadEvents as loadLeadEventsFromDb, loadLeadState, type NewLeadEvent } from "tandem-crm/db";
import { pool, WORKSPACE_ID } from "./db";
import { setDemoUser } from "./auth";
import { requireCurrentMember, getOnboardingSteps, getWaypointStrategy } from "./queries";
import { createStripePayoutAdapter } from "./stripePayoutAdapter";

/** The reference app is often run as a public demo, and neither the forms nor
 * the database cap text length, so each free-text field is capped here. */
const MAX_TEXT = 500;
function capText(value: string | undefined, label: string, max = MAX_TEXT): void {
  if (value !== undefined && value.length > max) throw new Error(`${label} must be ${max} characters or fewer`);
}

async function loadLeadEvents(client: import("pg").PoolClient, leadId: string): Promise<TandemEvent[]> {
  return loadLeadEventsFromDb(client, WORKSPACE_ID, leadId);
}

type DashboardMember = { userId: string; role: "owner" | "admin" | "agent" };

/** Approving, paying, adjusting, reinstating or clawing back a commission
 * is an operator decision, never an agent's on their own lead. Enforced
 * here as well as in the database (migration 021) so a caller gets a clear
 * error instead of relying on a silent RLS filter. */
function requireCommissionManager(member: { role: "owner" | "admin" | "agent" }): void {
  if (member.role !== "owner" && member.role !== "admin") {
    throw new Error("only a workspace owner or admin can approve, pay, or change a commission");
  }
}

/** Appends one event through the engine's writer (tandem-crm/db
 * appendLeadEvents): it locks the lead, replays and validates, reads back the
 * real sequence, syncs the lead and every changed payout line plus the
 * payout ledger, and checks every row count. Takes an open client so callers
 * that append more than one event atomically (logTrailVisit's stage sync)
 * share one transaction. */
async function appendLeadEventWithClient(
  client: import("pg").PoolClient,
  member: DashboardMember,
  leadId: string,
  type: TandemEvent["type"],
  data: TandemEvent["data"],
  idempotency?: { source: string; sourceEventId: string }
): Promise<void> {
  if (type.startsWith("commission.") || type.startsWith("payment.")) requireCommissionManager(member);
  await appendLeadEvents(client, {
    workspaceId: WORKSPACE_ID, leadId, actor: { role: member.role }, defaultSource: "dashboard",
    events: [{ type, data, source: idempotency?.source, sourceEventId: idempotency?.sourceEventId } as NewLeadEvent],
  });
}

async function appendLeadEvent(
  leadId: string,
  type: TandemEvent["type"],
  data: TandemEvent["data"],
  idempotency?: { source: string; sourceEventId: string }
): Promise<void> {
  const member = await requireCurrentMember();
  await withTandemSession(pool, member.userId, async (client) => {
    await appendLeadEventWithClient(client, member, leadId, type, data, idempotency);
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
  capText(reason, "reason");
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

/** Reference wiring of TandemPayoutAdapter for local development only: a
 * flat env var mapping partnerId -> Stripe connected account id. A real
 * deployment would resolve this from its own partners table instead --
 * see stripePayoutAdapter.ts's own comment. Throws with a clear setup
 * error rather than silently no-op'ing, the same fail-closed convention
 * TANDEM_AUTH_MODE=host's getHostUserId() uses. */
function getConfiguredPayoutAdapter(): TandemPayoutAdapter {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    throw new Error("STRIPE_SECRET_KEY is not configured; paying a commission requires a payout adapter.");
  }
  let connectedAccounts: Record<string, string>;
  try {
    connectedAccounts = JSON.parse(process.env.STRIPE_CONNECTED_ACCOUNTS ?? "{}");
  } catch {
    throw new Error("STRIPE_CONNECTED_ACCOUNTS must be valid JSON mapping partnerId to a Stripe connected account id.");
  }
  return createStripePayoutAdapter({
    stripeSecretKey,
    resolveConnectedAccountId: async (partnerId) => connectedAccounts[partnerId] ?? "",
  });
}

export async function approveCommission(leadId: string, payoutId: string): Promise<void> {
  await appendLeadEvent(leadId, "commission.approved", { payoutId });
}

/** Executes the real transfer through whatever TandemPayoutAdapter is
 * configured, then records commission.paid with the reference it returns.
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
  const member = await requireCurrentMember();
  requireCommissionManager(member);
  const adapter = getConfiguredPayoutAdapter();

  await withTandemSession(pool, member.userId, async (client) => {
    const state = await loadLeadState(client, WORKSPACE_ID, leadId);
    const commission = state?.commissions.find((line) => line.payoutId === payoutId);
    if (!commission) throw new Error("that payout does not belong to this lead");
    if (commission.status !== "approved") {
      throw new Error(`this commission is ${commission.status}; only an approved commission can be paid`);
    }

    const { payoutReference } = await adapter.executePayout({
      payoutId,
      partnerId: commission.partnerId,
      amountMinor: commission.amountMinor,
      currency: commission.currency,
      beneficiary: commission.beneficiary,
      paymentId: commission.paymentId,
    });
    await appendLeadEventWithClient(client, member, leadId, "commission.paid", { payoutId, payoutReference });
  });
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/");
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
      const strategy = await getWaypointStrategy(member.userId);
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

/** A profile is deliberately separate from login provisioning: Camp can create
 * the operational agent record, while the host's auth system remains the only
 * authority that links a real sign-in identity through tandem.members. */
export async function createAgentProfile(input: {
  displayName: string;
  externalRef?: string;
}): Promise<string> {
  const member = await requireCurrentMember();
  if (member.role !== "owner" && member.role !== "admin") {
    throw new Error("only a workspace owner or admin can add an agent profile");
  }
  capText(input.displayName, "display name", 200);
  capText(input.externalRef, "external reference", 200);
  const displayName = input.displayName.trim();
  const externalRef = input.externalRef?.trim() || null;
  if (!displayName) throw new Error("agent name is required");

  const agentId = randomUUID();
  await withTandemSession(pool, member.userId, (client) =>
    client.query(
      `insert into tandem.agents (id, workspace_id, display_name, external_ref)
       values ($1, $2, $3, $4)`,
      [agentId, WORKSPACE_ID, displayName, externalRef]
    )
  );
  revalidatePath("/");
  revalidatePath("/agents");
  revalidatePath(`/agents/${agentId}`);
  return agentId;
}

function requireWorkspaceManager(member: { role: "owner" | "admin" | "agent" }): void {
  if (member.role !== "owner" && member.role !== "admin") {
    throw new Error("only a workspace owner or admin can change workspace setup");
  }
}

export async function createOnboardingStep(input: {
  code: string;
  label: string;
  required: boolean;
}): Promise<void> {
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
      [WORKSPACE_ID]
    );
    await client.query(
      `insert into tandem.onboarding_steps (workspace_id, code, label, required, sort_order)
       values ($1, $2, $3, $4, $5)`,
      [WORKSPACE_ID, code, label, input.required, order.rows[0].next_order]
    );
  });
  revalidatePath("/");
  revalidatePath("/agents");
  revalidatePath("/settings/setup");
}

export async function createTerritory(input: { name: string; code: string }): Promise<void> {
  const member = await requireCurrentMember();
  requireWorkspaceManager(member);
  capText(input.name, "territory name", 200);
  capText(input.code, "territory code", 50);
  const name = input.name.trim();
  const code = input.code.trim().toUpperCase();
  if (!name) throw new Error("territory name is required");
  if (!/^[A-Z0-9_-]+$/.test(code)) throw new Error("territory code must use uppercase letters, numbers, hyphens, or underscores");

  await withTandemSession(pool, member.userId, (client) =>
    client.query(
      `insert into tandem.territories (workspace_id, name, code)
       values ($1, $2, $3)`,
      [WORKSPACE_ID, name, code]
    )
  );
  revalidatePath("/settings/setup");
  revalidatePath("/settings/waypoint");
}

export async function assignAgentToTerritory(agentId: string, territoryId: string): Promise<void> {
  const member = await requireCurrentMember();
  requireWorkspaceManager(member);
  await withTandemSession(pool, member.userId, (client) =>
    client.query(
      `insert into tandem.agent_territories (workspace_id, agent_id, territory_id)
       values ($1, $2, $3)
       on conflict do nothing`,
      [WORKSPACE_ID, agentId, territoryId]
    )
  );
  revalidatePath("/agents");
  revalidatePath(`/agents/${agentId}`);
  revalidatePath("/settings/setup");
}

export async function createCommissionRule(input: {
  productTag: string;
  currency: string;
  basisPoints: number;
  holdDays: number;
}): Promise<void> {
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
      [WORKSPACE_ID, productTag, currency, input.basisPoints, input.holdDays]
    )
  );
  revalidatePath("/settings/setup");
}

/** Links a user the host has already authenticated to one operational agent
 * profile. This never creates credentials or changes a person's workspace
 * privilege: managers may only add an agent membership, and an existing
 * membership is rejected rather than overwritten. */
export async function linkExistingUserToAgent(input: { userId: string; agentId: string }): Promise<void> {
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
      [agentId, WORKSPACE_ID]
    );
    if (agent.rowCount !== 1) throw new Error("agent profile was not found in this workspace");
    const existing = await client.query(
      "select id from tandem.members where workspace_id = $1 and user_id = $2",
      [WORKSPACE_ID, userId]
    );
    if (existing.rowCount !== 0) throw new Error("this host account is already linked to this workspace");
    await client.query(
      `insert into tandem.members (workspace_id, user_id, role, agent_id)
       values ($1, $2, 'agent', $3)`,
      [WORKSPACE_ID, userId, agentId]
    );
  });
  revalidatePath("/agents");
  revalidatePath(`/agents/${agentId}`);
  revalidatePath("/settings/setup");
}

export async function setWaypointStrategy(strategy: "round_robin" | "least_loaded" | "manual"): Promise<void> {
  const member = await requireCurrentMember();
  await withTandemSession(pool, member.userId, (client) =>
    client.query(
      `insert into tandem.waypoint_settings (workspace_id, strategy, updated_at) values ($1, $2, now())
       on conflict (workspace_id) do update set strategy = excluded.strategy, updated_at = now()`,
      [WORKSPACE_ID, strategy]
    )
  );
  revalidatePath("/settings/waypoint");
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
  /** PIC and address are optional and stored in `tandem.leads.attributes`
   * (see queries.ts's readAttributes) instead of their own columns, so a
   * host can add further ad hoc lead fields later without a migration. */
  contactName?: string;
  address?: string;
}): Promise<string> {
  const member = await requireCurrentMember();
  capText(input.companyName, "company name", 200);
  capText(input.contactPhone, "contact phone", 50);
  capText(input.productTag, "product tag", 100);
  capText(input.contactName, "contact name", 200);
  capText(input.address, "address");
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
    const attributes: Record<string, string> = {};
    if (input.contactName?.trim()) attributes.contactName = input.contactName.trim();
    if (input.address?.trim()) attributes.address = input.address.trim();
    await client.query(
      `insert into tandem.leads (id, workspace_id, company_name, contact_phone, qualification_metric, product_tag, attributes, pipeline_status, last_event_sequence)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [leadId, WORKSPACE_ID, state.companyName, input.contactPhone.trim(), state.qualificationMetric, input.productTag.trim(), JSON.stringify(attributes), state.status, state.lastSequence]
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
  if (type !== "dispute.opened") requireCommissionManager(member);
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
  capText(question, "question");
  await appendDisputeEvent(disputeId, "dispute.queried", { question: question.trim() });
}

export async function resolveDispute(disputeId: string, outcome: "upheld" | "dismissed", note: string): Promise<void> {
  if (!note.trim()) throw new Error("a resolution note is required");
  capText(note, "note");
  await appendDisputeEvent(disputeId, "dispute.resolved", { outcome, note: note.trim() });
}

/** Acting on an upheld dispute is a separate, explicit step from resolving
 * it (see belay.ts and migration 011's comments) -- the operator reviews
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
  requireCommissionManager(member);
  const idempotency = {
    source: "belay-dispute",
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

/** Mirrors src/trail.ts's own validateFields exactly -- this is a
 * clearer, earlier error for the dashboard's form, not a stricter rule
 * than the domain reducer already enforces. CHAMP fields stay optional
 * here too, for the same backward-compatibility reason: the reducer
 * itself can never require them (see trail.ts), so this action-layer
 * check can't either without becoming a lie about what the domain layer
 * actually accepts. */
function validateTrailInput(input: TrailInput): void {
  if (!trailVisitChannels.includes(input.channel)) throw new Error("invalid channel");
  if (!trailSalesStages.includes(input.salesStage)) throw new Error("invalid sales stage");
  for (const [label, value] of [["note", input.note], ["challenges", input.challenges], ["authority", input.authority], ["budget", input.budget], ["prioritization", input.prioritization]] as const) {
    capText(value, label);
  }
  if (!Number.isSafeInteger(input.confidenceRating) || input.confidenceRating < 1 || input.confidenceRating > 10) {
    throw new Error("confidence rating must be an integer from 1 to 10");
  }
  const hasContent = [input.note, input.challenges, input.authority, input.budget, input.prioritization]
    .some((field) => field?.trim());
  if (!hasContent) throw new Error("at least one of note, challenges, authority, budget, or prioritization is required");
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
         (id, workspace_id, lead_id, channel, confidence_rating, sales_stage, note, challenges, authority, budget, prioritization, logged_at, last_event_sequence)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [entryId, WORKSPACE_ID, leadId, state.channel, state.confidenceRating, state.salesStage, state.note,
        state.challenges, state.authority, state.budget, state.prioritization, state.loggedAt, state.lastSequence]
    );
    await syncLeadSalesStage(client, member, leadId, state.salesStage);
  });
  revalidatePath(`/leads/${leadId}`);
}

/** Keeps the lead's own promoted sales stage (queryable, drives the funnel
 * view) in sync with whatever an agent just logged in Trail, in the same
 * transaction as the trail write. A no-op append is skipped rather than
 * growing the Core event log with an event that changes nothing. */
async function syncLeadSalesStage(client: import("pg").PoolClient, member: DashboardMember, leadId: string, salesStage: TrailSalesStage): Promise<void> {
  const leadEvents = await loadLeadEvents(client, leadId);
  const leadState = replayLeadEvents(leadEvents, WORKSPACE_ID, leadId);
  if (!leadState || leadState.salesStage === salesStage) return;
  await appendLeadEventWithClient(client, member, leadId, "lead.stage_changed", { salesStage });
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
           challenges = $6, authority = $7, budget = $8, prioritization = $9,
           corrected_at = $10, retracted = $11, last_event_sequence = $12, updated_at = now()
       where id = $1 and workspace_id = $13 and lead_id = $14`,
      [entryId, state.channel, state.confidenceRating, state.salesStage, state.note,
        state.challenges, state.authority, state.budget, state.prioritization,
        state.correctedAt, state.retracted, state.lastSequence, WORKSPACE_ID, leadId]
    );
    if (!state.retracted) await syncLeadSalesStage(client, member, leadId, state.salesStage);
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
