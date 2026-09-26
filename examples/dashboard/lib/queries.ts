import { getCurrentTandemMember, type TandemMember } from "tandem-crm";
import { withTandemSession } from "tandem-crm/db";
import { pool, WORKSPACE_ID } from "./db";
import { dashboardAuthAdapter } from "./auth";

/** node-postgres parses timestamptz columns into Date objects, not the ISO
 * strings callers of these queries (and tandem-crm's event reducers)
 * expect. */
function toISO(value: string | Date): string;
function toISO(value: string | Date | null): string | null;
function toISO(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export async function currentMember(): Promise<TandemMember | null> {
  return getCurrentTandemMember(dashboardAuthAdapter, WORKSPACE_ID);
}

/** Convenience for pages that require a signed-in member; throws otherwise
 * (the demo middleware always sets a default user, so this should not
 * normally happen -- it's a real guard, not decoration). */
export async function requireCurrentMember(): Promise<TandemMember> {
  const member = await currentMember();
  if (!member) throw new Error("no current Tandem member for this session");
  return member;
}

export type PipelineCounts = Record<string, number>;

export async function getPipelineCounts(userId: string): Promise<PipelineCounts> {
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{ pipeline_status: string; count: string }>(
      `select pipeline_status, count(*) as count from tandem.leads
       where workspace_id = $1 group by pipeline_status`,
      [WORKSPACE_ID]
    )
  );
  const counts: PipelineCounts = {};
  for (const row of result.rows) counts[row.pipeline_status] = Number(row.count);
  return counts;
}

export type PendingPayoutsSummary = { count: number; totalMinor: number; currency: string | null };

export async function getPendingPayoutsSummary(userId: string): Promise<PendingPayoutsSummary> {
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{ count: string; total_minor: string | null; currency: string | null }>(
      `select count(*) as count, sum(amount_minor) as total_minor, min(currency) as currency
       from tandem.payouts where workspace_id = $1 and status in ('held', 'eligible')`,
      [WORKSPACE_ID]
    )
  );
  const row = result.rows[0];
  return { count: Number(row.count), totalMinor: Number(row.total_minor ?? 0), currency: row.currency };
}

export type AgentSummary = {
  id: string;
  displayName: string;
  active: boolean;
  startedAt: string | null;
  certifiedAt: string | null;
  completedStepCount: number;
  requiredStepCount: number;
  openLeadCount: number;
};

/** A certification fact stays current only while every currently-required
 * step is complete. Requirement templates can change after certification. */
export function isAgentCurrentlyCertified(
  agent: Pick<AgentSummary, "certifiedAt" | "completedStepCount" | "requiredStepCount">
): boolean {
  return agent.certifiedAt !== null && agent.completedStepCount === agent.requiredStepCount;
}

export async function getAgentSummaries(userId: string): Promise<AgentSummary[]> {
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{
      id: string;
      display_name: string;
      active: boolean;
      started_at: string | null;
      certified_at: string | null;
      completed_step_count: string;
      required_step_count: string;
      open_lead_count: string;
    }>(
      `select
         a.id, a.display_name, a.active,
         s.started_at, s.certified_at,
         coalesce((
           select count(*)
           from tandem.onboarding_steps os
           where os.workspace_id = a.workspace_id and os.required
             and exists (
               select 1 from tandem.agent_events e
               where e.workspace_id = a.workspace_id and e.agent_id = a.id
                 and e.event_type = 'onboarding.step_completed'
                 and e.payload->>'stepCode' = os.code
             )
         ), 0) as completed_step_count,
         (select count(*) from tandem.onboarding_steps os where os.workspace_id = a.workspace_id and os.required) as required_step_count,
         (select count(*) from tandem.leads l where l.workspace_id = a.workspace_id and l.assignee_id = a.id
            and l.pipeline_status not in ('Commission_Paid', 'Lost', 'Refunded')) as open_lead_count
       from tandem.agents a
       left join tandem.agent_onboarding_status s on s.workspace_id = a.workspace_id and s.agent_id = a.id
       where a.workspace_id = $1
       order by a.display_name`,
      [WORKSPACE_ID]
    )
  );
  return result.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    active: row.active,
    startedAt: toISO(row.started_at),
    certifiedAt: toISO(row.certified_at),
    completedStepCount: Number(row.completed_step_count),
    requiredStepCount: Number(row.required_step_count),
    openLeadCount: Number(row.open_lead_count),
  }));
}

export type OnboardingStep = { code: string; label: string; required: boolean; sortOrder: number };

export async function getOnboardingSteps(userId: string): Promise<OnboardingStep[]> {
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{ code: string; label: string; required: boolean; sort_order: number }>(
      `select code, label, required, sort_order from tandem.onboarding_steps
       where workspace_id = $1 order by sort_order`,
      [WORKSPACE_ID]
    )
  );
  return result.rows.map((row) => ({ code: row.code, label: row.label, required: row.required, sortOrder: row.sort_order }));
}

export type AgentDetail = {
  id: string;
  displayName: string;
  active: boolean;
  startedAt: string | null;
  certifiedAt: string | null;
  completedStepCodes: string[];
  leads: Array<{ id: string; companyName: string; pipelineStatus: string; updatedAt: string }>;
};

export async function getAgentDetail(userId: string, agentId: string): Promise<AgentDetail | null> {
  return withTandemSession(pool, userId, async (client) => {
    const agentResult = await client.query<{
      id: string; display_name: string; active: boolean;
      started_at: string | null; certified_at: string | null;
    }>(
      `select a.id, a.display_name, a.active, s.started_at, s.certified_at
       from tandem.agents a
       left join tandem.agent_onboarding_status s on s.workspace_id = a.workspace_id and s.agent_id = a.id
       where a.id = $1 and a.workspace_id = $2`,
      [agentId, WORKSPACE_ID]
    );
    const agent = agentResult.rows[0];
    if (!agent) return null;

    const stepsResult = await client.query<{ step_code: string }>(
      `select distinct payload->>'stepCode' as step_code
       from tandem.agent_events
       where agent_id = $1 and workspace_id = $2 and event_type = 'onboarding.step_completed'`,
      [agentId, WORKSPACE_ID]
    );

    const leadsResult = await client.query<{ id: string; company_name: string; pipeline_status: string; updated_at: string }>(
      `select id, company_name, pipeline_status, updated_at from tandem.leads
       where assignee_id = $1 and workspace_id = $2 order by updated_at desc`,
      [agentId, WORKSPACE_ID]
    );

    return {
      id: agent.id,
      displayName: agent.display_name,
      active: agent.active,
      startedAt: toISO(agent.started_at),
      certifiedAt: toISO(agent.certified_at),
      completedStepCodes: stepsResult.rows.map((r) => r.step_code),
      leads: leadsResult.rows.map((r) => ({
        id: r.id, companyName: r.company_name, pipelineStatus: r.pipeline_status, updatedAt: toISO(r.updated_at),
      })),
    };
  });
}

export type LeadSummary = {
  id: string;
  companyName: string;
  qualificationMetric: number;
  pipelineStatus: string;
  assigneeId: string | null;
  assigneeName: string | null;
  updatedAt: string;
};

export async function getLeads(userId: string): Promise<LeadSummary[]> {
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{
      id: string; company_name: string; qualification_metric: number; pipeline_status: string;
      assignee_id: string | null; assignee_name: string | null; updated_at: string;
    }>(
      `select l.id, l.company_name, l.qualification_metric, l.pipeline_status, l.assignee_id,
              a.display_name as assignee_name, l.updated_at
       from tandem.leads l
       left join tandem.agents a on a.id = l.assignee_id and a.workspace_id = l.workspace_id
       where l.workspace_id = $1
       order by l.updated_at desc`
      , [WORKSPACE_ID]
    )
  );
  return result.rows.map((row) => ({
    id: row.id, companyName: row.company_name, qualificationMetric: row.qualification_metric,
    pipelineStatus: row.pipeline_status, assigneeId: row.assignee_id, assigneeName: row.assignee_name,
    updatedAt: toISO(row.updated_at),
  }));
}

export type LeadDetail = LeadSummary & {
  events: Array<{ id: string; type: string; payload: Record<string, unknown>; occurredAt: string }>;
};

export async function getLeadDetail(userId: string, leadId: string): Promise<LeadDetail | null> {
  return withTandemSession(pool, userId, async (client) => {
    const leadResult = await client.query<{
      id: string; company_name: string; qualification_metric: number; pipeline_status: string;
      assignee_id: string | null; assignee_name: string | null; updated_at: string;
    }>(
      `select l.id, l.company_name, l.qualification_metric, l.pipeline_status, l.assignee_id,
              a.display_name as assignee_name, l.updated_at
       from tandem.leads l
       left join tandem.agents a on a.id = l.assignee_id and a.workspace_id = l.workspace_id
       where l.id = $1 and l.workspace_id = $2`,
      [leadId, WORKSPACE_ID]
    );
    const lead = leadResult.rows[0];
    if (!lead) return null;

    const eventsResult = await client.query<{ id: string; event_type: string; payload: Record<string, unknown>; occurred_at: string }>(
      `select id, event_type, payload, occurred_at from tandem.events
       where lead_id = $1 and workspace_id = $2 order by sequence`,
      [leadId, WORKSPACE_ID]
    );

    return {
      id: lead.id, companyName: lead.company_name, qualificationMetric: lead.qualification_metric,
      pipelineStatus: lead.pipeline_status, assigneeId: lead.assignee_id, assigneeName: lead.assignee_name,
      updatedAt: toISO(lead.updated_at),
      events: eventsResult.rows.map((r) => ({ id: r.id, type: r.event_type, payload: r.payload, occurredAt: toISO(r.occurred_at) })),
    };
  });
}

export type PayoutSummary = {
  id: string;
  leadId: string;
  companyName: string;
  amountMinor: number;
  currency: string;
  status: string;
  releaseAt: string;
  paidAt: string | null;
};

export async function getPayouts(userId: string): Promise<PayoutSummary[]> {
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{
      id: string; lead_id: string; company_name: string; amount_minor: string;
      currency: string; status: string; release_at: string; paid_at: string | null;
    }>(
      `select p.id, p.lead_id, l.company_name, p.amount_minor, p.currency, p.status, p.release_at, p.paid_at
       from tandem.payouts p
       join tandem.leads l on l.id = p.lead_id and l.workspace_id = p.workspace_id
       where p.workspace_id = $1
       order by p.release_at desc`,
      [WORKSPACE_ID]
    )
  );
  return result.rows.map((row) => ({
    id: row.id, leadId: row.lead_id, companyName: row.company_name,
    amountMinor: Number(row.amount_minor), currency: row.currency, status: row.status,
    releaseAt: toISO(row.release_at), paidAt: row.paid_at ? toISO(row.paid_at) : null,
  }));
}

export type RoutingStrategy = "round_robin" | "least_loaded" | "manual";

export async function getRoutingStrategy(userId: string): Promise<RoutingStrategy> {
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{ strategy: RoutingStrategy }>(
      `select strategy from tandem.routing_settings where workspace_id = $1 limit 1`,
      [WORKSPACE_ID]
    )
  );
  return result.rows[0]?.strategy ?? "round_robin";
}

export type LeadsPage = { leads: LeadSummary[]; total: number; page: number; pageSize: number };

/** Paginated variant of getLeads, for the Leads list view. The kanban view
 * still uses getLeads directly: paging a board grouped by status would
 * split a status column mid-page, which is worse than just loading all of
 * it (a real deployment with thousands of leads would want per-column
 * paging instead, out of scope for this reference dashboard). */
export async function getLeadsPage(userId: string, page: number, pageSize: number): Promise<LeadsPage> {
  const safePage = Math.max(1, page);
  const offset = (safePage - 1) * pageSize;
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{
      id: string; company_name: string; qualification_metric: number; pipeline_status: string;
      assignee_id: string | null; assignee_name: string | null; updated_at: string; total_count: string;
    }>(
      `select l.id, l.company_name, l.qualification_metric, l.pipeline_status, l.assignee_id,
              a.display_name as assignee_name, l.updated_at, count(*) over () as total_count
       from tandem.leads l
       left join tandem.agents a on a.id = l.assignee_id and a.workspace_id = l.workspace_id
       where l.workspace_id = $1
       order by l.updated_at desc
       limit $2 offset $3`,
      [WORKSPACE_ID, pageSize, offset]
    )
  );
  return {
    leads: result.rows.map((row) => ({
      id: row.id, companyName: row.company_name, qualificationMetric: row.qualification_metric,
      pipelineStatus: row.pipeline_status, assigneeId: row.assignee_id, assigneeName: row.assignee_name,
      updatedAt: toISO(row.updated_at),
    })),
    total: result.rows.length > 0 ? Number(result.rows[0].total_count) : 0,
    page: safePage,
    pageSize,
  };
}

export type DisputeSummary = {
  id: string;
  leadId: string;
  companyName: string;
  payoutId: string;
  category: "untracked" | "incorrect" | "declined";
  status: "open" | "queried" | "resolved";
  outcome: "upheld" | "dismissed" | null;
  openedByAgentName: string;
  openedAt: string;
  autoApproveAt: string;
};

export async function getDisputes(userId: string): Promise<DisputeSummary[]> {
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{
      id: string; lead_id: string; company_name: string; payout_id: string;
      category: DisputeSummary["category"]; status: DisputeSummary["status"]; outcome: DisputeSummary["outcome"];
      opened_by_agent_name: string; opened_at: string; auto_approve_at: string;
    }>(
      `select d.id, d.lead_id, l.company_name, d.payout_id, d.category, d.status, d.outcome,
              a.display_name as opened_by_agent_name, d.opened_at, d.auto_approve_at
       from tandem.disputes d
       join tandem.leads l on l.id = d.lead_id and l.workspace_id = d.workspace_id
       join tandem.agents a on a.id = d.opened_by_agent_id and a.workspace_id = d.workspace_id
       where d.workspace_id = $1
       order by (d.status = 'resolved'), d.opened_at desc`
      , [WORKSPACE_ID]
    )
  );
  return result.rows.map((row) => ({
    id: row.id, leadId: row.lead_id, companyName: row.company_name, payoutId: row.payout_id,
    category: row.category, status: row.status, outcome: row.outcome,
    openedByAgentName: row.opened_by_agent_name, openedAt: toISO(row.opened_at), autoApproveAt: toISO(row.auto_approve_at),
  }));
}

export type DisputeDetail = DisputeSummary & {
  expectedAmountMinor: number | null;
  description: string;
  resolutionNote: string | null;
  payoutAmountMinor: number;
  payoutCurrency: string;
  payoutStatus: string;
  payoutClawbackAmountMinor: number | null;
  outcomeApplied: boolean;
  events: Array<{ id: string; type: string; payload: Record<string, unknown>; occurredAt: string }>;
};

export async function getDisputeDetail(userId: string, disputeId: string): Promise<DisputeDetail | null> {
  return withTandemSession(pool, userId, async (client) => {
    const disputeResult = await client.query<{
      id: string; lead_id: string; company_name: string; payout_id: string;
      category: DisputeSummary["category"]; status: DisputeSummary["status"]; outcome: DisputeSummary["outcome"];
      opened_by_agent_name: string; opened_at: string; auto_approve_at: string;
      expected_amount_minor: number | null; description: string; resolution_note: string | null;
      payout_amount_minor: string; payout_currency: string; payout_status: string; payout_clawback_amount_minor: string | null;
      outcome_applied: boolean;
    }>(
      `select d.id, d.lead_id, l.company_name, d.payout_id, d.category, d.status, d.outcome,
              a.display_name as opened_by_agent_name, d.opened_at, d.auto_approve_at,
              d.expected_amount_minor, d.description, d.resolution_note,
              p.amount_minor as payout_amount_minor, p.currency as payout_currency,
              p.status as payout_status, p.clawback_amount_minor as payout_clawback_amount_minor,
              exists (
                select 1 from tandem.events e
                where e.workspace_id = d.workspace_id
                  and e.lead_id = d.lead_id
                  and e.source = 'coaster-dispute'
                  and e.source_event_id = 'dispute:' || d.id::text || ':outcome'
              ) as outcome_applied
       from tandem.disputes d
       join tandem.leads l on l.id = d.lead_id and l.workspace_id = d.workspace_id
       join tandem.agents a on a.id = d.opened_by_agent_id and a.workspace_id = d.workspace_id
       join tandem.payouts p on p.id = d.payout_id and p.workspace_id = d.workspace_id
       where d.id = $1 and d.workspace_id = $2`,
      [disputeId, WORKSPACE_ID]
    );
    const dispute = disputeResult.rows[0];
    if (!dispute) return null;

    const eventsResult = await client.query<{ id: string; event_type: string; payload: Record<string, unknown>; occurred_at: string }>(
      `select id, event_type, payload, occurred_at from tandem.dispute_events
       where dispute_id = $1 and workspace_id = $2 order by sequence`,
      [disputeId, WORKSPACE_ID]
    );

    return {
      id: dispute.id, leadId: dispute.lead_id, companyName: dispute.company_name, payoutId: dispute.payout_id,
      category: dispute.category, status: dispute.status, outcome: dispute.outcome,
      openedByAgentName: dispute.opened_by_agent_name, openedAt: toISO(dispute.opened_at), autoApproveAt: toISO(dispute.auto_approve_at),
      expectedAmountMinor: dispute.expected_amount_minor, description: dispute.description, resolutionNote: dispute.resolution_note,
      payoutAmountMinor: Number(dispute.payout_amount_minor), payoutCurrency: dispute.payout_currency, payoutStatus: dispute.payout_status,
      payoutClawbackAmountMinor: dispute.payout_clawback_amount_minor === null ? null : Number(dispute.payout_clawback_amount_minor),
      outcomeApplied: dispute.outcome_applied,
      events: eventsResult.rows.map((r) => ({ id: r.id, type: r.event_type, payload: r.payload, occurredAt: toISO(r.occurred_at) })),
    };
  });
}

export type TrailEntrySummary = {
  id: string;
  channel: "phone" | "physical" | "email";
  confidenceRating: number;
  salesStage: "New" | "Contacted" | "Qualified" | "Negotiating" | "Closed_Won" | "Closed_Lost";
  note: string;
  loggedAt: string;
  correctedAt: string | null;
  retracted: boolean;
};

export async function getTrailEntries(userId: string, leadId: string): Promise<TrailEntrySummary[]> {
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{
      id: string; channel: TrailEntrySummary["channel"]; confidence_rating: number;
      sales_stage: TrailEntrySummary["salesStage"]; note: string;
      logged_at: string; corrected_at: string | null; retracted: boolean;
    }>(
      `select id, channel, confidence_rating, sales_stage, note, logged_at, corrected_at, retracted
       from tandem.trail_entries where lead_id = $1 and workspace_id = $2 order by logged_at asc`,
      [leadId, WORKSPACE_ID]
    )
  );
  return result.rows.map((row) => ({
    id: row.id, channel: row.channel, confidenceRating: row.confidence_rating, salesStage: row.sales_stage,
    note: row.note, loggedAt: toISO(row.logged_at), correctedAt: toISO(row.corrected_at), retracted: row.retracted,
  }));
}

export type EarningsSummary = { lifetimeMinor: number; yearMinor: number; monthMinor: number; weekMinor: number; currency: string | null };

/** Paid commissions only -- held/eligible/approved money hasn't actually
 * been earned yet, and a clawback on a paid one still counts as earned
 * (the clawback is a separate obligation, not an undo of the payment). */
export async function getEarningsSummary(userId: string): Promise<EarningsSummary> {
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{ lifetime_minor: string; year_minor: string; month_minor: string; week_minor: string; currency: string | null }>(
      `select
         coalesce(sum(amount_minor), 0) as lifetime_minor,
         coalesce(sum(amount_minor) filter (where paid_at >= date_trunc('year', now())), 0) as year_minor,
         coalesce(sum(amount_minor) filter (where paid_at >= date_trunc('month', now())), 0) as month_minor,
         coalesce(sum(amount_minor) filter (where paid_at >= date_trunc('week', now())), 0) as week_minor,
         min(currency) as currency
       from tandem.payouts where workspace_id = $1 and status = 'paid'`,
      [WORKSPACE_ID]
    )
  );
  const row = result.rows[0];
  return {
    lifetimeMinor: Number(row?.lifetime_minor ?? 0), yearMinor: Number(row?.year_minor ?? 0),
    monthMinor: Number(row?.month_minor ?? 0), weekMinor: Number(row?.week_minor ?? 0),
    currency: row?.currency ?? null,
  };
}

export type MonthlyMetrics = { month: string; commissionsClosedCount: number; commissionsClosedMinor: number; leadsCreatedCount: number };

/** Last 6 full months including the current one, oldest first, with a zero
 * row for any month with no activity -- a chart with a silently missing
 * month reads as a data bug, not "nothing happened." */
export async function getMonthlyMetrics(userId: string): Promise<MonthlyMetrics[]> {
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{ month: string; commissions_closed_count: string; commissions_closed_minor: string; leads_created_count: string }>(
      `with months as (
         select to_char(date_trunc('month', now()) - (n || ' months')::interval, 'YYYY-MM') as month
         from generate_series(0, 5) as n
       ),
       closed as (
         select to_char(date_trunc('month', paid_at), 'YYYY-MM') as month,
                count(*) as commissions_closed_count, sum(amount_minor) as commissions_closed_minor
         from tandem.payouts
         where workspace_id = $1 and status = 'paid' and paid_at >= date_trunc('month', now()) - interval '5 months'
         group by 1
       ),
       created as (
         select to_char(date_trunc('month', created_at), 'YYYY-MM') as month, count(*) as leads_created_count
         from tandem.leads
         where workspace_id = $1 and created_at >= date_trunc('month', now()) - interval '5 months'
         group by 1
       )
       select months.month,
              coalesce(closed.commissions_closed_count, 0) as commissions_closed_count,
              coalesce(closed.commissions_closed_minor, 0) as commissions_closed_minor,
              coalesce(created.leads_created_count, 0) as leads_created_count
       from months
       left join closed on closed.month = months.month
       left join created on created.month = months.month
       order by months.month`,
      [WORKSPACE_ID]
    )
  );
  return result.rows.map((row) => ({
    month: row.month,
    commissionsClosedCount: Number(row.commissions_closed_count),
    commissionsClosedMinor: Number(row.commissions_closed_minor),
    leadsCreatedCount: Number(row.leads_created_count),
  }));
}
