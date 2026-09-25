import { getCurrentTandemMember, type TandemMember } from "tandem-crm";
import { withTandemSession } from "tandem-crm/db";
import { pool, WORKSPACE_ID } from "./db";
import { demoAuthAdapter } from "./auth";

/** node-postgres parses timestamptz columns into Date objects, not the ISO
 * strings callers of these queries (and tandem-crm's event reducers)
 * expect. */
function toISO(value: string | Date): string;
function toISO(value: string | Date | null): string | null;
function toISO(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export async function currentMember(): Promise<TandemMember | null> {
  return getCurrentTandemMember(demoAuthAdapter, WORKSPACE_ID);
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
      `select pipeline_status, count(*) as count from tandem.leads group by pipeline_status`
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
       from tandem.payouts where status in ('held', 'eligible')`
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
         coalesce(array_length(nullif(cs.completed, '{}'::text[]), 1), 0) as completed_step_count,
         (select count(*) from tandem.onboarding_steps os where os.workspace_id = a.workspace_id and os.required) as required_step_count,
         (select count(*) from tandem.leads l where l.assignee_id = a.id
            and l.pipeline_status not in ('Commission_Paid', 'Lost', 'Refunded')) as open_lead_count
       from tandem.agents a
       left join tandem.agent_onboarding_status s on s.workspace_id = a.workspace_id and s.agent_id = a.id
       left join lateral (
         select array_agg(distinct (payload->>'stepCode')) as completed
         from tandem.agent_events e
         where e.workspace_id = a.workspace_id and e.agent_id = a.id and e.event_type = 'onboarding.step_completed'
       ) cs on true
       order by a.display_name`
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
      `select code, label, required, sort_order from tandem.onboarding_steps order by sort_order`
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
       where a.id = $1`,
      [agentId]
    );
    const agent = agentResult.rows[0];
    if (!agent) return null;

    const stepsResult = await client.query<{ step_code: string }>(
      `select distinct payload->>'stepCode' as step_code
       from tandem.agent_events
       where agent_id = $1 and event_type = 'onboarding.step_completed'`,
      [agentId]
    );

    const leadsResult = await client.query<{ id: string; company_name: string; pipeline_status: string; updated_at: string }>(
      `select id, company_name, pipeline_status, updated_at from tandem.leads where assignee_id = $1 order by updated_at desc`,
      [agentId]
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
       left join tandem.agents a on a.id = l.assignee_id
       order by l.updated_at desc`
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
       left join tandem.agents a on a.id = l.assignee_id
       where l.id = $1`,
      [leadId]
    );
    const lead = leadResult.rows[0];
    if (!lead) return null;

    const eventsResult = await client.query<{ id: string; event_type: string; payload: Record<string, unknown>; occurred_at: string }>(
      `select id, event_type, payload, occurred_at from tandem.events where lead_id = $1 order by sequence`,
      [leadId]
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
};

export async function getPayouts(userId: string): Promise<PayoutSummary[]> {
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{
      id: string; lead_id: string; company_name: string; amount_minor: string;
      currency: string; status: string; release_at: string;
    }>(
      `select p.id, p.lead_id, l.company_name, p.amount_minor, p.currency, p.status, p.release_at
       from tandem.payouts p
       join tandem.leads l on l.id = p.lead_id
       order by p.release_at desc`
    )
  );
  return result.rows.map((row) => ({
    id: row.id, leadId: row.lead_id, companyName: row.company_name,
    amountMinor: Number(row.amount_minor), currency: row.currency, status: row.status, releaseAt: toISO(row.release_at),
  }));
}

export type RoutingStrategy = "round_robin" | "least_loaded" | "manual";

export async function getRoutingStrategy(userId: string): Promise<RoutingStrategy> {
  const result = await withTandemSession(pool, userId, (client) =>
    client.query<{ strategy: RoutingStrategy }>(`select strategy from tandem.routing_settings limit 1`)
  );
  return result.rows[0]?.strategy ?? "round_robin";
}
