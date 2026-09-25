-- Tandem P1: Supabase Auth identity mapping + RLS + workspace isolation.
-- Reviewed and applied 2026-09-25 — see src/packages/tandem-crm/README.md's
-- own "Security and migration status" section for the posture this
-- completes (Auth/RLS/least-privilege was explicitly the gate before any
-- Tandem route could be exposed).

-- Bridges a real Supabase Auth user to a workspace + role. `agent_id` is
-- optional: an owner/admin doesn't necessarily carry leads themselves, but
-- every agent who should be able to log in needs a member row pointing at
-- their own agent_id so lead-scoping (below) knows which rows are "theirs".
create table tandem.members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'agent')),
  agent_id uuid,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id),
  foreign key (workspace_id, agent_id) references tandem.agents(workspace_id, id) on delete set null
);

create index tandem_members_user_idx on tandem.members (user_id);

-- Helper functions, defined before any policy uses them. All three are
-- `security definer` so they read tandem.members bypassing that table's
-- OWN RLS — the standard, recommended way to avoid a policy needing to
-- query the very table it protects (a well-known RLS recursion trap).
-- None are given execute rights beyond `authenticated`; nothing here is
-- callable by anon or exposed as a public RPC.

create function tandem.current_role(target_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from tandem.members
  where workspace_id = target_workspace_id and user_id = auth.uid()
  limit 1;
$$;
revoke all on function tandem.current_role(uuid) from public;
grant execute on function tandem.current_role(uuid) to authenticated;

create function tandem.is_workspace_admin(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from tandem.members
    where workspace_id = target_workspace_id and user_id = auth.uid() and role in ('owner', 'admin')
  );
$$;
revoke all on function tandem.is_workspace_admin(uuid) from public;
grant execute on function tandem.is_workspace_admin(uuid) to authenticated;

create function tandem.current_agent_id(target_workspace_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select agent_id from tandem.members
  where workspace_id = target_workspace_id and user_id = auth.uid()
  limit 1;
$$;
revoke all on function tandem.current_agent_id(uuid) from public;
grant execute on function tandem.current_agent_id(uuid) to authenticated;

-- tandem.members itself: a user always sees their own membership row(s);
-- an owner/admin additionally sees every member row in their workspace
-- (needed to actually manage a team). Both branches go through the
-- definer functions above, not a direct self-query, so there's no
-- recursion.
alter table tandem.members enable row level security;

create policy tandem_members_select on tandem.members
  for select
  using (
    user_id = auth.uid()
    or tandem.is_workspace_admin(workspace_id)
  );

create policy tandem_members_admin_write on tandem.members
  for insert
  with check (tandem.is_workspace_admin(workspace_id));

create policy tandem_members_admin_update on tandem.members
  for update
  using (tandem.is_workspace_admin(workspace_id))
  with check (tandem.is_workspace_admin(workspace_id));

create policy tandem_members_admin_delete on tandem.members
  for delete
  using (tandem.is_workspace_admin(workspace_id));

-- workspaces: readable by any member; only an owner/admin of that same
-- workspace may update it (creation happens via the service role during
-- onboarding, not by an authenticated user directly, so no insert policy).
alter table tandem.workspaces enable row level security;

create policy tandem_workspaces_select on tandem.workspaces
  for select
  using (tandem.current_role(id) is not null);

create policy tandem_workspaces_admin_update on tandem.workspaces
  for update
  using (tandem.is_workspace_admin(id))
  with check (tandem.is_workspace_admin(id));

-- Config tables (agents, territories, agent_territories, commission_rules):
-- every member of the workspace can read them (an agent needs to see their
-- own territory/commission rule to make sense of a lead), only an
-- owner/admin can write.
alter table tandem.agents enable row level security;
create policy tandem_agents_select on tandem.agents
  for select using (tandem.current_role(workspace_id) is not null);
create policy tandem_agents_admin_write on tandem.agents
  for insert with check (tandem.is_workspace_admin(workspace_id));
create policy tandem_agents_admin_update on tandem.agents
  for update using (tandem.is_workspace_admin(workspace_id)) with check (tandem.is_workspace_admin(workspace_id));
create policy tandem_agents_admin_delete on tandem.agents
  for delete using (tandem.is_workspace_admin(workspace_id));

alter table tandem.territories enable row level security;
create policy tandem_territories_select on tandem.territories
  for select using (tandem.current_role(workspace_id) is not null);
create policy tandem_territories_admin_write on tandem.territories
  for insert with check (tandem.is_workspace_admin(workspace_id));
create policy tandem_territories_admin_update on tandem.territories
  for update using (tandem.is_workspace_admin(workspace_id)) with check (tandem.is_workspace_admin(workspace_id));
create policy tandem_territories_admin_delete on tandem.territories
  for delete using (tandem.is_workspace_admin(workspace_id));

alter table tandem.agent_territories enable row level security;
create policy tandem_agent_territories_select on tandem.agent_territories
  for select using (tandem.current_role(workspace_id) is not null);
create policy tandem_agent_territories_admin_write on tandem.agent_territories
  for insert with check (tandem.is_workspace_admin(workspace_id));
create policy tandem_agent_territories_admin_delete on tandem.agent_territories
  for delete using (tandem.is_workspace_admin(workspace_id));

alter table tandem.commission_rules enable row level security;
create policy tandem_commission_rules_select on tandem.commission_rules
  for select using (tandem.current_role(workspace_id) is not null);
create policy tandem_commission_rules_admin_write on tandem.commission_rules
  for insert with check (tandem.is_workspace_admin(workspace_id));
create policy tandem_commission_rules_admin_update on tandem.commission_rules
  for update using (tandem.is_workspace_admin(workspace_id)) with check (tandem.is_workspace_admin(workspace_id));
create policy tandem_commission_rules_admin_delete on tandem.commission_rules
  for delete using (tandem.is_workspace_admin(workspace_id));

-- leads: an agent sees ONLY leads assigned to them; an owner/admin sees
-- every lead in the workspace. This is the actual "scoped lead view"
-- P2 needs — enforced here at the database layer, not just in app code.
-- No insert/update/delete policy for any authenticated role: leads are a
-- rebuildable projection, written only by the transactional event/
-- projection writer (P1's other open item), which runs under the
-- service role — never a direct authenticated write.
alter table tandem.leads enable row level security;
create policy tandem_leads_select on tandem.leads
  for select
  using (
    tandem.is_workspace_admin(workspace_id)
    or assignee_id = tandem.current_agent_id(workspace_id)
  );

-- events: append-only audit log. An owner/admin can read every event in
-- their workspace; an agent can read events for leads they can see (same
-- assignee check as above, via a lookup against tandem.leads — a plain
-- subquery is fine here, this isn't self-referential). No client insert/
-- update/delete policy at all — the immutability trigger already blocks
-- update/delete outright, and inserts only ever come from the service
-- role's own transactional writer.
alter table tandem.events enable row level security;
create policy tandem_events_select on tandem.events
  for select
  using (
    tandem.is_workspace_admin(workspace_id)
    or lead_id in (
      select id from tandem.leads
      where leads.workspace_id = events.workspace_id
        and leads.assignee_id = tandem.current_agent_id(events.workspace_id)
    )
  );

-- payouts / payout_ledger: same shape as leads — an agent sees only their
-- own payouts (matched via the lead they're assigned), an owner/admin
-- sees everything. No client write policy — payouts are written by
-- release_due_commissions() and the (not yet built) commission-approval
-- action, both service-role operations.
alter table tandem.payouts enable row level security;
create policy tandem_payouts_select on tandem.payouts
  for select
  using (
    tandem.is_workspace_admin(workspace_id)
    or lead_id in (
      select id from tandem.leads
      where leads.workspace_id = payouts.workspace_id
        and leads.assignee_id = tandem.current_agent_id(payouts.workspace_id)
    )
  );

alter table tandem.payout_ledger enable row level security;
create policy tandem_payout_ledger_select on tandem.payout_ledger
  for select
  using (
    tandem.is_workspace_admin(workspace_id)
    or payout_id in (
      select id from tandem.payouts
      where payouts.workspace_id = payout_ledger.workspace_id
        and payouts.lead_id in (
          select id from tandem.leads
          where leads.workspace_id = payout_ledger.workspace_id
            and leads.assignee_id = tandem.current_agent_id(payout_ledger.workspace_id)
        )
    )
  );
