-- Coaster: partner-initiated commission disputes and operator adjudication.
-- Like Ramp, this module has its own append-only event log and projection
-- rather than writing into tandem.events / domain.ts's reducer (see
-- 008_tandem_ramp.sql's comment for why: that table's lead_id is NOT NULL
-- and its reducer is built around exactly the eleven event types already
-- defined there). Coaster reads Core's leads and payouts but never writes
-- them directly, with one deliberate exception at the bottom of this file:
-- release_due_commissions() is taught to skip a payout under an unresolved
-- dispute, which is the actual "brake" this module exists to apply.
--
-- Scope of this first slice: opening a dispute, an operator asking for more
-- information, and an operator resolving it as upheld or dismissed. Resolving
-- a dispute only records the outcome here; it does not itself append a
-- commission.adjusted, commission.reinstated, or commission.clawback_requested
-- event into Core's own log, the same "the engine never touches money" split
-- Core already draws for commission.held. Acting on an upheld outcome is a
-- separate, explicit event the host app appends to tandem.events after
-- reading this dispute's category and outcome (see domain.ts's comment above
-- those three event types). A scheduled function that auto-resolves overdue
-- disputes is still follow-up work.

create table tandem.dispute_events (
  sequence bigint generated always as identity primary key,
  id uuid not null default gen_random_uuid() unique,
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  dispute_id uuid not null,
  lead_id uuid not null,
  payout_id uuid not null,
  source text not null check (source = lower(btrim(source)) and length(source) > 0),
  source_event_id text not null check (source_event_id = btrim(source_event_id) and length(source_event_id) > 0),
  event_type text not null check (event_type in ('dispute.opened', 'dispute.queried', 'dispute.resolved')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source, source_event_id),
  foreign key (workspace_id, lead_id) references tandem.leads(workspace_id, id) on delete restrict,
  foreign key (workspace_id, payout_id) references tandem.payouts(workspace_id, id) on delete restrict
);

create index tandem_dispute_events_replay_idx
  on tandem.dispute_events (workspace_id, dispute_id, sequence);

create trigger tandem_dispute_events_immutable
before update or delete on tandem.dispute_events
for each row execute function tandem.reject_event_mutation();

-- The rebuildable projection of dispute_events, mirroring how
-- tandem.agent_onboarding_status projects tandem.agent_events.
create table tandem.disputes (
  id uuid primary key,
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  lead_id uuid not null,
  payout_id uuid not null,
  opened_by_agent_id uuid not null,
  category text not null check (category in ('untracked', 'incorrect', 'declined')),
  expected_amount_minor bigint check (expected_amount_minor is null or expected_amount_minor >= 0),
  description text not null check (length(btrim(description)) > 0),
  status text not null default 'open' check (status in ('open', 'queried', 'resolved')),
  outcome text check (outcome in ('upheld', 'dismissed')),
  resolution_note text,
  opened_at timestamptz not null,
  auto_approve_at timestamptz not null,
  last_event_sequence bigint,
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, lead_id) references tandem.leads(workspace_id, id) on delete restrict,
  foreign key (workspace_id, payout_id) references tandem.payouts(workspace_id, id) on delete restrict,
  foreign key (workspace_id, opened_by_agent_id) references tandem.agents(workspace_id, id) on delete restrict
);

create index tandem_disputes_open_idx
  on tandem.disputes (workspace_id, payout_id)
  where status in ('open', 'queried');

-- RLS. Reuses 007's helpers (is_workspace_admin, current_agent_id); none
-- are redefined here. Visibility is by the lead's CURRENT assignee, same
-- shape as tandem_leads_select, not by who originally opened the dispute --
-- if a lead is reassigned, the new agent inherits visibility into it, same
-- as they inherit the lead itself.
alter table tandem.dispute_events enable row level security;

create policy tandem_dispute_events_select on tandem.dispute_events
  for select
  using (
    tandem.is_workspace_admin(workspace_id)
    or exists (
      select 1 from tandem.leads l
      where l.workspace_id = tandem.dispute_events.workspace_id
        and l.id = tandem.dispute_events.lead_id
        and l.assignee_id = tandem.current_agent_id(tandem.dispute_events.workspace_id)
    )
  );

-- Only an admin may insert dispute.queried or dispute.resolved: this is the
-- actual database-level enforcement of "partners open, operators resolve",
-- not just an application-layer convention.
create policy tandem_dispute_events_insert on tandem.dispute_events
  for insert
  with check (
    tandem.is_workspace_admin(workspace_id)
    or (
      event_type = 'dispute.opened'
      and exists (
        select 1 from tandem.leads l
        where l.workspace_id = tandem.dispute_events.workspace_id
          and l.id = tandem.dispute_events.lead_id
          and l.assignee_id = tandem.current_agent_id(tandem.dispute_events.workspace_id)
      )
    )
  );

-- disputes: same visibility as the event log it is projected from. Any
-- write here is expected to follow a validated dispute_events insert, so
-- its own write policy mirrors that table's, matching how
-- tandem_leads_update (010) mirrors tandem_leads_select's shape.
alter table tandem.disputes enable row level security;

create policy tandem_disputes_select on tandem.disputes
  for select
  using (
    tandem.is_workspace_admin(workspace_id)
    or exists (
      select 1 from tandem.leads l
      where l.workspace_id = tandem.disputes.workspace_id
        and l.id = tandem.disputes.lead_id
        and l.assignee_id = tandem.current_agent_id(tandem.disputes.workspace_id)
    )
  );

create policy tandem_disputes_insert on tandem.disputes
  for insert
  with check (
    tandem.is_workspace_admin(workspace_id)
    or exists (
      select 1 from tandem.leads l
      where l.workspace_id = tandem.disputes.workspace_id
        and l.id = tandem.disputes.lead_id
        and l.assignee_id = tandem.current_agent_id(tandem.disputes.workspace_id)
    )
  );

create policy tandem_disputes_update on tandem.disputes
  for update
  using (
    tandem.is_workspace_admin(workspace_id)
    or exists (
      select 1 from tandem.leads l
      where l.workspace_id = tandem.disputes.workspace_id
        and l.id = tandem.disputes.lead_id
        and l.assignee_id = tandem.current_agent_id(tandem.disputes.workspace_id)
    )
  )
  with check (
    tandem.is_workspace_admin(workspace_id)
    or exists (
      select 1 from tandem.leads l
      where l.workspace_id = tandem.disputes.workspace_id
        and l.id = tandem.disputes.lead_id
        and l.assignee_id = tandem.current_agent_id(tandem.disputes.workspace_id)
    )
  );

-- dispute_events is genuinely append-only (the trigger above already blocks
-- update/delete outright), so it gets no update/delete grant, same as
-- tandem.events and tandem.agent_events. disputes is a mutable projection,
-- so it gets update but still no delete.
grant select, insert on tandem.dispute_events to authenticated;
grant select, insert, update on tandem.disputes to authenticated;

-- The one place Coaster changes Core's own behavior: a payout under an
-- open or queried dispute never becomes eligible for release, even once its
-- hold period has passed. Everything else in this function is 004's body,
-- unchanged, including its returns/security posture; a scheduled caller
-- keeps working exactly as before for every payout with no dispute on it.
create or replace function tandem.release_due_commissions()
returns table (payout_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  due tandem.payouts%rowtype;
  eligible_event_id uuid;
  eligible_event_sequence bigint;
begin
  for due in
    -- due.id cannot be referenced inside the query that produces due itself
    -- (it is not bound yet); alias the source row as p and correlate to
    -- that instead, or the not-exists check silently evaluates against a
    -- null and never excludes anything.
    select p.* from tandem.payouts p
    where p.status = 'held' and p.release_at <= now()
      and not exists (
        select 1 from tandem.disputes d
        where d.payout_id = p.id and d.status in ('open', 'queried')
      )
    order by p.release_at, p.id
    for update skip locked
  loop
    insert into tandem.events (
      workspace_id, entity_type, entity_id, lead_id, source, source_event_id,
      event_type, payload, occurred_at
    ) values (
      due.workspace_id, 'payout', due.id, due.lead_id, 'tandem-engine',
      'payout:' || due.id::text || ':eligible', 'commission.eligible',
      pg_catalog.jsonb_build_object('payoutId', due.id), now()
    )
    on conflict (workspace_id, source, source_event_id) do nothing
    returning id, sequence into eligible_event_id, eligible_event_sequence;

    if eligible_event_id is null then
      raise exception 'held payout % already has an eligibility event', due.id;
    end if;

    update tandem.payouts
    set status = 'eligible', last_event_id = eligible_event_id, updated_at = now()
    where id = due.id and workspace_id = due.workspace_id;

    update tandem.leads
    set pipeline_status = 'Commission_Eligible',
        last_event_sequence = eligible_event_sequence,
        updated_at = now()
    where id = due.lead_id and workspace_id = due.workspace_id
      and pipeline_status = 'Commission_Hold';
    if not found then
      raise exception 'lead projection for payout % is not on commission hold', due.id;
    end if;

    insert into tandem.payout_ledger (
      workspace_id, payout_id, event_id, from_status, to_status
    ) values (
      due.workspace_id, due.id, eligible_event_id, 'held', 'eligible'
    );
    payout_id := due.id;
    return next;
  end loop;
end;
$$;
revoke all on function tandem.release_due_commissions() from public;
