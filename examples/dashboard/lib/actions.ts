"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import {
  replayLeadEvents,
  replayAgentOnboardingEvents,
  selectAgentForLead,
  type TandemEvent,
  type AgentOnboardingEvent,
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
     from tandem.events where lead_id = $1 order by sequence`,
    [leadId]
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
  data: TandemEvent["data"]
): Promise<void> {
  const member = await requireCurrentMember();
  await withTandemSession(pool, member.userId, async (client) => {
    const existing = await loadLeadEvents(client, leadId);
    const nextSequence = existing.length > 0 ? existing[existing.length - 1].sequence + 1 : 1;
    const newEvent = {
      id: randomUUID(), sequence: nextSequence, workspaceId: WORKSPACE_ID, leadId,
      source: "dashboard", sourceEventId: `dashboard-${randomUUID()}`, occurredAt: new Date().toISOString(),
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
       where id = $1`,
      [leadId, state.status, state.agentId, state.territoryId, state.lastSequence]
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
      `select territory_id, assignee_id from tandem.leads where id = $1`,
      [leadId]
    );
    territoryId = leadRow.rows[0]?.territory_id ?? null;

    if (!resolvedAgentId) {
      if (!territoryId) throw new Error("lead has no territory to route within");
      const strategy = await getRoutingStrategy(member.userId);
      const candidatesResult = await client.query<{ agent_id: string; open_lead_count: string }>(
        `select at.agent_id, (
           select count(*) from tandem.leads l
           where l.assignee_id = at.agent_id and l.pipeline_status not in ('Commission_Paid', 'Lost', 'Refunded')
         ) as open_lead_count
         from tandem.agent_territories at
         join tandem.agents a on a.id = at.agent_id and a.active
         where at.territory_id = $1`,
        [territoryId]
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
     from tandem.agent_events where agent_id = $1 order by sequence`,
    [agentId]
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

export async function switchDemoUser(userId: string): Promise<void> {
  await setDemoUser(userId);
  revalidatePath("/");
}
