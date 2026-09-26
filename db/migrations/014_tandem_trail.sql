-- Trail: a lightweight per-lead activity log -- visit reports (phone,
-- physical, or email), a confidence rating, a sales stage, and a free-text
-- note for objections/remarks. Deliberately not a full CRM object model:
-- see src/trail.ts's top comment. Tandem itself never reads or acts on
-- Trail data; it is purely something an agent records and an owner/admin
-- reviews, the same non-enforcement split as everywhere else in this
-- schema.
--
-- Own event log rather than tandem.events, for the same reason Ramp and
-- Coaster have their own: 002's tandem.events has no room for a per-entry
-- identity the way this needs (one lead can have many trail entries, each
-- independently correctable/retractable), so this gets its own small,
-- parallel append-only log and rebuildable projection instead of bending
-- Core's schema to fit.
--
-- Unlike Ramp/Coaster, this migration grants both SELECT and the write
-- path (INSERT on the event log, INSERT/UPDATE on the projection) in one
-- pass: migration 013 had to follow up on a gap where authenticated had no
-- UPDATE grant on tandem.payouts at all, discovered only after the domain
-- events already existed. Not repeating that here.

create table tandem.trail_events (
  sequence bigint generated always as identity primary key,
  id uuid not null default gen_random_uuid() unique,
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  lead_id uuid not null,
  entry_id uuid not null,
  source text not null check (source = lower(btrim(source)) and length(source) > 0),
  source_event_id text not null check (source_event_id = btrim(source_event_id) and length(source_event_id) > 0),
  event_type text not null check (event_type in ('trail.visit_logged', 'trail.entry_corrected', 'trail.entry_retracted')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source, source_event_id),
  foreign key (workspace_id, lead_id) references tandem.leads(workspace_id, id) on delete restrict
);

create index tandem_trail_events_replay_idx
  on tandem.trail_events (workspace_id, lead_id, entry_id, sequence);

create trigger tandem_trail_events_immutable
before update or delete on tandem.trail_events
for each row execute function tandem.reject_event_mutation();

-- Rebuildable projection: one row per entry_id, mirroring
-- replayTrailEntryEvents' TrailEntryState.
create table tandem.trail_entries (
  id uuid primary key,
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  lead_id uuid not null,
  channel text not null check (channel in ('phone', 'physical', 'email')),
  confidence_rating smallint not null check (confidence_rating between 1 and 10),
  sales_stage text not null check (sales_stage in ('New', 'Contacted', 'Qualified', 'Negotiating', 'Closed_Won', 'Closed_Lost')),
  note text not null check (length(btrim(note)) > 0),
  logged_at timestamptz not null,
  corrected_at timestamptz,
  retracted boolean not null default false,
  last_event_sequence bigint,
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, lead_id) references tandem.leads(workspace_id, id) on delete restrict
);

create index tandem_trail_entries_lead_idx
  on tandem.trail_entries (workspace_id, lead_id, logged_at);

-- RLS. Reuses 007's helpers; none are redefined here. Same visibility and
-- write shape as tandem.leads/tandem.events: an admin sees and writes
-- everything in the workspace, an agent only what's on a lead currently
-- assigned to them.

alter table tandem.trail_events enable row level security;

create policy tandem_trail_events_select on tandem.trail_events
  for select
  using (
    tandem.is_workspace_admin(workspace_id)
    or lead_id in (
      select id from tandem.leads
      where tandem.leads.workspace_id = tandem.trail_events.workspace_id
        and tandem.leads.assignee_id = tandem.current_agent_id(tandem.trail_events.workspace_id)
    )
  );

create policy tandem_trail_events_insert on tandem.trail_events
  for insert
  with check (
    tandem.is_workspace_admin(workspace_id)
    or lead_id in (
      select id from tandem.leads
      where tandem.leads.workspace_id = tandem.trail_events.workspace_id
        and tandem.leads.assignee_id = tandem.current_agent_id(tandem.trail_events.workspace_id)
    )
  );

alter table tandem.trail_entries enable row level security;

create policy tandem_trail_entries_select on tandem.trail_entries
  for select
  using (
    tandem.is_workspace_admin(workspace_id)
    or lead_id in (
      select id from tandem.leads
      where tandem.leads.workspace_id = tandem.trail_entries.workspace_id
        and tandem.leads.assignee_id = tandem.current_agent_id(tandem.trail_entries.workspace_id)
    )
  );

create policy tandem_trail_entries_insert on tandem.trail_entries
  for insert
  with check (
    tandem.is_workspace_admin(workspace_id)
    or lead_id in (
      select id from tandem.leads
      where tandem.leads.workspace_id = tandem.trail_entries.workspace_id
        and tandem.leads.assignee_id = tandem.current_agent_id(tandem.trail_entries.workspace_id)
    )
  );

create policy tandem_trail_entries_update on tandem.trail_entries
  for update
  using (
    tandem.is_workspace_admin(workspace_id)
    or lead_id in (
      select id from tandem.leads
      where tandem.leads.workspace_id = tandem.trail_entries.workspace_id
        and tandem.leads.assignee_id = tandem.current_agent_id(tandem.trail_entries.workspace_id)
    )
  )
  with check (
    tandem.is_workspace_admin(workspace_id)
    or lead_id in (
      select id from tandem.leads
      where tandem.leads.workspace_id = tandem.trail_entries.workspace_id
        and tandem.leads.assignee_id = tandem.current_agent_id(tandem.trail_entries.workspace_id)
    )
  );

grant select, insert on tandem.trail_events to authenticated;
grant select, insert, update on tandem.trail_entries to authenticated;
