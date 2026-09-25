-- Tandem P1 portability follow-up: make the 005/006 auth + RLS layer work
-- on ANY Postgres host (Neon, RDS, Aiven, plain Postgres), not just
-- Supabase.
--
-- 005 and 006 each silently depended on something Supabase provisions that
-- no other Postgres host has. Confirmed empirically against a fresh, plain
-- Postgres 16 instance (and cross-checked against live Supabase
-- production), three separate root causes:
--
--   1. `auth.users` does not exist. 005's very first statement, the
--      `references auth.users(id)` on tandem.members, fails outright on a
--      non-Supabase host, and every later statement in 005 cascades to
--      fail with it.
--   2. `auth.uid()` does not exist. The three helper functions in 005 call
--      it directly. Moot on a fresh install once fix (1) lands (they never
--      got created), but real on existing Supabase production, where 005
--      already succeeded and these functions exist with auth.uid() baked
--      in.
--   3. The `authenticated` role does not exist. Every `grant ... to
--      authenticated` in 005 and 006 fails without it.
--
-- This migration is idempotent and safe to run in either state:
--
--   (a) a fresh non-Supabase host, where 005 and 006 never successfully
--       ran at all, and
--   (b) live Supabase production, where 005 and 006 already fully
--       succeeded.
--
-- After 007 runs, both states end up in the same place: `authenticated`
-- exists, tandem.members exists without a hard FK into a host user store,
-- every identity helper resolves through tandem.current_user_id(), and
-- every RLS policy and grant from 005/006 is in place and reachable.
--
-- 007 has never been applied anywhere, so unlike 005/006 it carries no
-- backward-compat constraint on its own text.

-- Section 1: portable `authenticated` role. Supabase provisions it; no
-- other host does. Policies and grants below all target it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end;
$$;

-- Section 2: portable tandem.members. Two states to reconcile: a fresh
-- non-Supabase host where 005's CREATE TABLE never ran, and Supabase
-- production where it did (with a hard FK into auth.users).
do $$
begin
  if not exists (
    select 1 from pg_tables where schemaname = 'tandem' and tablename = 'members'
  ) then
    -- Fresh non-Supabase install: 005's CREATE TABLE never ran (see root
    -- cause 1 above). Create it here without the hard auth.users FK --
    -- referential integrity against the host's own user store becomes the
    -- connecting application's job, the same way it already is for any
    -- non-Supabase auth provider.
    create table tandem.members (
      id uuid primary key default gen_random_uuid(),
      workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
      user_id uuid not null,
      role text not null check (role in ('owner', 'admin', 'agent')),
      agent_id uuid,
      created_at timestamptz not null default now(),
      unique (workspace_id, user_id),
      foreign key (workspace_id, agent_id) references tandem.agents(workspace_id, id) on delete set null
    );
    create index tandem_members_user_idx on tandem.members (user_id);
  else
    -- Already exists (Supabase production, or any host where 005 already
    -- succeeded): drop the hard FK to auth.users if it's still there. The
    -- column, table, and index are otherwise left exactly as 005 built them.
    if exists (select 1 from pg_constraint where conname = 'members_user_id_fkey') then
      alter table tandem.members drop constraint members_user_id_fkey;
    end if;
  end if;
end;
$$;

-- Section 3: the portable identity helper plus the three existing helpers,
-- fixed. 005's helpers called auth.uid() directly (root cause 2); they now
-- all resolve identity through tandem.current_user_id(), which prefers a
-- host-agnostic `tandem.user_id` GUC and falls back to auth.uid() only
-- where it actually exists. Re-issuing revoke/grant on an unchanged
-- signature is harmless and idempotent, and is kept here for the case
-- where 005 never created these functions at all.

create or replace function tandem.current_user_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  session_user_id text;
  supabase_uid uuid;
begin
  session_user_id := current_setting('tandem.user_id', true);
  if session_user_id is not null and session_user_id <> '' then
    return session_user_id::uuid;
  end if;

  if to_regprocedure('auth.uid()') is not null then
    execute 'select auth.uid()' into supabase_uid;
    return supabase_uid;
  end if;

  return null;
end;
$$;
revoke all on function tandem.current_user_id() from public;
grant execute on function tandem.current_user_id() to authenticated;

create or replace function tandem.current_role(target_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from tandem.members
  where workspace_id = target_workspace_id and user_id = tandem.current_user_id()
  limit 1;
$$;
revoke all on function tandem.current_role(uuid) from public;
grant execute on function tandem.current_role(uuid) to authenticated;

create or replace function tandem.is_workspace_admin(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from tandem.members
    where workspace_id = target_workspace_id and user_id = tandem.current_user_id() and role in ('owner', 'admin')
  );
$$;
revoke all on function tandem.is_workspace_admin(uuid) from public;
grant execute on function tandem.is_workspace_admin(uuid) to authenticated;

create or replace function tandem.current_agent_id(target_workspace_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select agent_id from tandem.members
  where workspace_id = target_workspace_id and user_id = tandem.current_user_id()
  limit 1;
$$;
revoke all on function tandem.current_agent_id(uuid) from public;
grant execute on function tandem.current_agent_id(uuid) to authenticated;

-- Section 4: re-establish every RLS policy from 005, idempotently. Each
-- policy is preceded by `drop policy if exists` so it is safe whether 005
-- originally succeeded (Supabase -- drop then recreate identically) or
-- failed (fresh host -- the drop is a no-op, the create succeeds). Policy
-- logic is reproduced verbatim from 005; only the drops are added.

-- tandem.members itself: a user always sees their own membership row(s);
-- an owner/admin additionally sees every member row in their workspace
-- (needed to actually manage a team). Both branches go through the
-- definer functions above, not a direct self-query, so there's no
-- recursion.
alter table tandem.members enable row level security;

drop policy if exists tandem_members_select on tandem.members;
create policy tandem_members_select on tandem.members
  for select
  using (
    user_id = tandem.current_user_id()
    or tandem.is_workspace_admin(workspace_id)
  );

drop policy if exists tandem_members_admin_write on tandem.members;
create policy tandem_members_admin_write on tandem.members
  for insert
  with check (tandem.is_workspace_admin(workspace_id));

drop policy if exists tandem_members_admin_update on tandem.members;
create policy tandem_members_admin_update on tandem.members
  for update
  using (tandem.is_workspace_admin(workspace_id))
  with check (tandem.is_workspace_admin(workspace_id));

drop policy if exists tandem_members_admin_delete on tandem.members;
create policy tandem_members_admin_delete on tandem.members
  for delete
  using (tandem.is_workspace_admin(workspace_id));

-- workspaces: readable by any member; only an owner/admin of that same
-- workspace may update it (creation happens via the service role during
-- onboarding, not by an authenticated user directly, so no insert policy).
alter table tandem.workspaces enable row level security;

drop policy if exists tandem_workspaces_select on tandem.workspaces;
create policy tandem_workspaces_select on tandem.workspaces
  for select
  using (tandem.current_role(id) is not null);

drop policy if exists tandem_workspaces_admin_update on tandem.workspaces;
create policy tandem_workspaces_admin_update on tandem.workspaces
  for update
  using (tandem.is_workspace_admin(id))
  with check (tandem.is_workspace_admin(id));

-- Config tables (agents, territories, agent_territories, commission_rules):
-- every member of the workspace can read them (an agent needs to see their
-- own territory/commission rule to make sense of a lead), only an
-- owner/admin can write.
alter table tandem.agents enable row level security;
drop policy if exists tandem_agents_select on tandem.agents;
create policy tandem_agents_select on tandem.agents
  for select using (tandem.current_role(workspace_id) is not null);
drop policy if exists tandem_agents_admin_write on tandem.agents;
create policy tandem_agents_admin_write on tandem.agents
  for insert with check (tandem.is_workspace_admin(workspace_id));
drop policy if exists tandem_agents_admin_update on tandem.agents;
create policy tandem_agents_admin_update on tandem.agents
  for update using (tandem.is_workspace_admin(workspace_id)) with check (tandem.is_workspace_admin(workspace_id));
drop policy if exists tandem_agents_admin_delete on tandem.agents;
create policy tandem_agents_admin_delete on tandem.agents
  for delete using (tandem.is_workspace_admin(workspace_id));

alter table tandem.territories enable row level security;
drop policy if exists tandem_territories_select on tandem.territories;
create policy tandem_territories_select on tandem.territories
  for select using (tandem.current_role(workspace_id) is not null);
drop policy if exists tandem_territories_admin_write on tandem.territories;
create policy tandem_territories_admin_write on tandem.territories
  for insert with check (tandem.is_workspace_admin(workspace_id));
drop policy if exists tandem_territories_admin_update on tandem.territories;
create policy tandem_territories_admin_update on tandem.territories
  for update using (tandem.is_workspace_admin(workspace_id)) with check (tandem.is_workspace_admin(workspace_id));
drop policy if exists tandem_territories_admin_delete on tandem.territories;
create policy tandem_territories_admin_delete on tandem.territories
  for delete using (tandem.is_workspace_admin(workspace_id));

alter table tandem.agent_territories enable row level security;
drop policy if exists tandem_agent_territories_select on tandem.agent_territories;
create policy tandem_agent_territories_select on tandem.agent_territories
  for select using (tandem.current_role(workspace_id) is not null);
drop policy if exists tandem_agent_territories_admin_write on tandem.agent_territories;
create policy tandem_agent_territories_admin_write on tandem.agent_territories
  for insert with check (tandem.is_workspace_admin(workspace_id));
drop policy if exists tandem_agent_territories_admin_delete on tandem.agent_territories;
create policy tandem_agent_territories_admin_delete on tandem.agent_territories
  for delete using (tandem.is_workspace_admin(workspace_id));

alter table tandem.commission_rules enable row level security;
drop policy if exists tandem_commission_rules_select on tandem.commission_rules;
create policy tandem_commission_rules_select on tandem.commission_rules
  for select using (tandem.current_role(workspace_id) is not null);
drop policy if exists tandem_commission_rules_admin_write on tandem.commission_rules;
create policy tandem_commission_rules_admin_write on tandem.commission_rules
  for insert with check (tandem.is_workspace_admin(workspace_id));
drop policy if exists tandem_commission_rules_admin_update on tandem.commission_rules;
create policy tandem_commission_rules_admin_update on tandem.commission_rules
  for update using (tandem.is_workspace_admin(workspace_id)) with check (tandem.is_workspace_admin(workspace_id));
drop policy if exists tandem_commission_rules_admin_delete on tandem.commission_rules;
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
drop policy if exists tandem_leads_select on tandem.leads;
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
drop policy if exists tandem_events_select on tandem.events;
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
drop policy if exists tandem_payouts_select on tandem.payouts;
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
drop policy if exists tandem_payout_ledger_select on tandem.payout_ledger;
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

-- Section 5: re-issue every grant from 006. GRANT is idempotent, so these
-- are safe whether 006 already succeeded (Supabase) or never ran (fresh
-- non-Supabase host, where they would have failed on the missing
-- `authenticated` role before Section 1 above created it).

grant usage on schema tandem to authenticated;

grant select, update on tandem.workspaces to authenticated;
grant select, insert, update, delete on tandem.members to authenticated;
grant select, insert, update, delete on tandem.agents to authenticated;
grant select, insert, update, delete on tandem.territories to authenticated;
grant select, insert, delete on tandem.agent_territories to authenticated;
grant select, insert, update, delete on tandem.commission_rules to authenticated;

-- leads/events/payouts/payout_ledger have no write policy in 005 (all
-- written by the service-role projection writer), so only SELECT is
-- granted here — an insert/update/delete attempt from `authenticated`
-- should fail at this same grant check, not rely on RLS to block it.
grant select on tandem.leads to authenticated;
grant select on tandem.events to authenticated;
grant select on tandem.payouts to authenticated;
grant select on tandem.payout_ledger to authenticated;
