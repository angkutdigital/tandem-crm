import { getCurrentTandemMember, type TandemMember } from "tandem-crm";
import { withTandemSession } from "tandem-crm/db";
import { getTandemCampConfig } from "./config.js";

/** node-postgres parses timestamptz columns into Date objects, not the ISO
 * strings callers of these queries (and tandem-crm's event reducers)
 * expect. */
function toISO(value: string | Date): string;
function toISO(value: string | Date | null): string | null;
function toISO(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export async function currentMember(): Promise<TandemMember | null> {
  const { authAdapter, workspaceId } = getTandemCampConfig();
  return getCurrentTandemMember(authAdapter, workspaceId);
}

/** Convenience for views that require a signed-in member; throws otherwise. */
export async function requireCurrentMember(): Promise<TandemMember> {
  const member = await currentMember();
  if (!member) throw new Error("no current Tandem member for this session");
  return member;
}

export type PipelineCounts = Record<string, number>;

export async function getPipelineCounts(userId: string): Promise<PipelineCounts> {
  const { pool, workspaceId } = getTandemCampConfig();
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{ pipeline_status: string; count: string }>(
      `select pipeline_status, count(*) as count from tandem.leads
       where workspace_id = $1 group by pipeline_status`,
      [workspaceId]
    )
  );
  const counts: PipelineCounts = {};
  for (const row of result.rows) counts[row.pipeline_status] = Number(row.count);
  return counts;
}

export type PendingPayoutsSummary = { count: number; totalMinor: number; currency: string | null };

export async function getPendingPayoutsSummary(userId: string): Promise<PendingPayoutsSummary> {
  const { pool, workspaceId } = getTandemCampConfig();
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{ count: string; total_minor: string | null; currency: string | null }>(
      `select count(*) as count, sum(amount_minor) as total_minor, min(currency) as currency
       from tandem.payouts where workspace_id = $1 and status in ('held', 'eligible')`,
      [workspaceId]
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
  const { pool, workspaceId } = getTandemCampConfig();
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
      [workspaceId]
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

export type LeadSummary = {
  id: string;
  companyName: string;
  qualificationMetric: number;
  pipelineStatus: string;
  salesStage: string;
  assigneeId: string | null;
  assigneeName: string | null;
  updatedAt: string;
};

export type LeadsPage = { leads: LeadSummary[]; total: number; page: number; pageSize: number };

/** Paginated lead list. */
export async function getLeadsPage(userId: string, page: number, pageSize: number): Promise<LeadsPage> {
  const { pool, workspaceId } = getTandemCampConfig();
  const safePage = Math.max(1, page);
  const offset = (safePage - 1) * pageSize;
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{
      id: string; company_name: string; qualification_metric: number; pipeline_status: string; sales_stage: string;
      assignee_id: string | null; assignee_name: string | null; updated_at: string; total_count: string;
    }>(
      `select l.id, l.company_name, l.qualification_metric, l.pipeline_status, l.sales_stage, l.assignee_id,
              a.display_name as assignee_name, l.updated_at, count(*) over () as total_count
       from tandem.leads l
       left join tandem.agents a on a.id = l.assignee_id and a.workspace_id = l.workspace_id
       where l.workspace_id = $1
       order by l.updated_at desc
       limit $2 offset $3`,
      [workspaceId, pageSize, offset]
    )
  );
  return {
    leads: result.rows.map((row) => ({
      id: row.id, companyName: row.company_name, qualificationMetric: row.qualification_metric,
      pipelineStatus: row.pipeline_status, salesStage: row.sales_stage, assigneeId: row.assignee_id, assigneeName: row.assignee_name,
      updatedAt: toISO(row.updated_at),
    })),
    total: result.rows.length > 0 ? Number(result.rows[0].total_count) : 0,
    page: safePage,
    pageSize,
  };
}

export type PayoutSummary = {
  id: string;
  leadId: string;
  partnerId: string;
  companyName: string;
  amountMinor: number;
  currency: string;
  status: "held" | "eligible" | "approved" | "paid" | "voided";
  releaseAt: string;
  paidAt: string | null;
};

export async function getPayouts(userId: string): Promise<PayoutSummary[]> {
  const { pool, workspaceId } = getTandemCampConfig();
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{
      id: string; lead_id: string; partner_id: string; company_name: string; amount_minor: string;
      currency: string; status: PayoutSummary["status"]; release_at: string; paid_at: string | null;
    }>(
      `select p.id, p.lead_id, p.partner_id, l.company_name, p.amount_minor, p.currency, p.status, p.release_at, p.paid_at
       from tandem.payouts p
       join tandem.leads l on l.id = p.lead_id and l.workspace_id = p.workspace_id
       where p.workspace_id = $1
       order by p.release_at desc`,
      [workspaceId]
    )
  );
  return result.rows.map((row) => ({
    id: row.id, leadId: row.lead_id, partnerId: row.partner_id, companyName: row.company_name,
    amountMinor: Number(row.amount_minor), currency: row.currency, status: row.status,
    releaseAt: toISO(row.release_at), paidAt: row.paid_at ? toISO(row.paid_at) : null,
  }));
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
  const { pool, workspaceId } = getTandemCampConfig();
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
      , [workspaceId]
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
  const { pool, workspaceId } = getTandemCampConfig();
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
                  and e.source = 'belay-dispute'
                  and e.source_event_id = 'dispute:' || d.id::text || ':outcome'
              ) as outcome_applied
       from tandem.disputes d
       join tandem.leads l on l.id = d.lead_id and l.workspace_id = d.workspace_id
       join tandem.agents a on a.id = d.opened_by_agent_id and a.workspace_id = d.workspace_id
       join tandem.payouts p on p.id = d.payout_id and p.workspace_id = d.workspace_id
       where d.id = $1 and d.workspace_id = $2`,
      [disputeId, workspaceId]
    );
    const dispute = disputeResult.rows[0];
    if (!dispute) return null;

    const eventsResult = await client.query<{ id: string; event_type: string; payload: Record<string, unknown>; occurred_at: string }>(
      `select id, event_type, payload, occurred_at from tandem.dispute_events
       where dispute_id = $1 and workspace_id = $2 order by sequence`,
      [disputeId, workspaceId]
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
