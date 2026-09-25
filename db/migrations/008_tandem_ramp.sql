-- Ramp: sales-agent onboarding and certification tracking. Ramp records
-- whether an agent has completed a workspace-defined checklist of named
-- steps and whether they are certified. It deliberately enforces nothing:
-- whether certification blocks a territory assignment, commission release,
-- or anything else is the implementing application's decision, the same way
-- Core only ever tracks state and never enforces policy.
--
-- Why Ramp has its own events table instead of tandem.events: 002's
-- tandem.events requires `lead_id uuid not null` and restricts entity_type
-- to ('lead', 'payout'). Onboarding events are scoped to an agent, not a
-- lead, and have no lead_id to give them. Rather than loosen that NOT NULL
-- constraint (tandem.events' lead-replay index and Core's whole reducer are
-- built around it), Ramp gets its own small, parallel append-only log,
-- tandem.agent_events, mirroring tandem.events' exact shape and
-- immutability pattern -- right down to reusing the existing
-- tandem.reject_event_mutation() trigger function rather than defining a
-- new one.

-- Section 1: the per-workspace step template. Config-shaped like
-- tandem.commission_rules: mutable, admin-managed, one row per required (or
-- optional) onboarding step.

create table tandem.onboarding_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  code text not null check (length(btrim(code)) > 0),
  label text not null check (length(btrim(label)) > 0),
  required boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, code)
);

-- Section 2: the append-only onboarding event log. Same shape and
-- immutability guarantee as tandem.events, but scoped to an agent.

create table tandem.agent_events (
  sequence bigint generated always as identity primary key,
  id uuid not null default gen_random_uuid() unique,
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  agent_id uuid not null,
  source text not null check (source = lower(btrim(source)) and length(source) > 0),
  source_event_id text not null check (source_event_id = btrim(source_event_id) and length(source_event_id) > 0),
  event_type text not null check (event_type in ('onboarding.started', 'onboarding.step_completed', 'onboarding.certified')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source, source_event_id),
  foreign key (workspace_id, agent_id) references tandem.agents(workspace_id, id) on delete restrict
);

create index tandem_agent_events_replay_idx
  on tandem.agent_events (workspace_id, agent_id, sequence);

create trigger tandem_agent_events_immutable
before update or delete on tandem.agent_events
for each row execute function tandem.reject_event_mutation();

-- Section 3: the rebuildable projection of agent_events, mirroring how
-- tandem.leads and tandem.payouts are projections of tandem.events.

create table tandem.agent_onboarding_status (
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  agent_id uuid not null,
  started_at timestamptz,
  certified_at timestamptz,
  last_event_sequence bigint,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, agent_id),
  foreign key (workspace_id, agent_id) references tandem.agents(workspace_id, id) on delete restrict
);

-- Section 4: RLS. Reuses the existing 007 helpers (current_role,
-- is_workspace_admin, current_agent_id); none are redefined here.

alter table tandem.onboarding_steps enable row level security;

drop policy if exists tandem_onboarding_steps_select on tandem.onboarding_steps;
create policy tandem_onboarding_steps_select on tandem.onboarding_steps
  for select using (tandem.current_role(workspace_id) is not null);
drop policy if exists tandem_onboarding_steps_admin_write on tandem.onboarding_steps;
create policy tandem_onboarding_steps_admin_write on tandem.onboarding_steps
  for insert with check (tandem.is_workspace_admin(workspace_id));
drop policy if exists tandem_onboarding_steps_admin_update on tandem.onboarding_steps;
create policy tandem_onboarding_steps_admin_update on tandem.onboarding_steps
  for update using (tandem.is_workspace_admin(workspace_id)) with check (tandem.is_workspace_admin(workspace_id));
drop policy if exists tandem_onboarding_steps_admin_delete on tandem.onboarding_steps;
create policy tandem_onboarding_steps_admin_delete on tandem.onboarding_steps
  for delete using (tandem.is_workspace_admin(workspace_id));

-- agent_events: an owner/admin sees every event in their workspace; an
-- agent sees only their own onboarding history. No client write policy at
-- all; the immutability trigger already blocks update/delete outright, and
-- inserts only ever come from the service-role projection writer.
alter table tandem.agent_events enable row level security;
drop policy if exists tandem_agent_events_select on tandem.agent_events;
create policy tandem_agent_events_select on tandem.agent_events
  for select
  using (
    tandem.is_workspace_admin(workspace_id)
    or agent_id = tandem.current_agent_id(workspace_id)
  );

-- agent_onboarding_status: same visibility shape as the event log it is
-- projected from. No write policy; it is written by the projection writer.
alter table tandem.agent_onboarding_status enable row level security;
drop policy if exists tandem_agent_onboarding_status_select on tandem.agent_onboarding_status;
create policy tandem_agent_onboarding_status_select on tandem.agent_onboarding_status
  for select
  using (
    tandem.is_workspace_admin(workspace_id)
    or agent_id = tandem.current_agent_id(workspace_id)
  );

-- Section 5: grants. onboarding_steps is admin-managed config, so the
-- authenticated role gets full CRUD (RLS narrows writes to admins);
-- agent_events/agent_onboarding_status are service-role written, so only
-- SELECT is granted.
grant select, insert, update, delete on tandem.onboarding_steps to authenticated;
grant select on tandem.agent_events to authenticated;
grant select on tandem.agent_onboarding_status to authenticated;
