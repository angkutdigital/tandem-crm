-- Append order is sequence, not provider-supplied occurred_at.
-- source must be trimmed/lowercase by the adapter; source_event_id is case-sensitive.
create table tandem.events (
  sequence bigint generated always as identity primary key,
  id uuid not null default gen_random_uuid() unique,
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  entity_type text not null check (entity_type in ('lead', 'payout')),
  entity_id uuid not null,
  lead_id uuid not null,
  source text not null check (source = lower(btrim(source)) and length(source) > 0),
  source_event_id text not null check (source_event_id = btrim(source_event_id) and length(source_event_id) > 0),
  event_type text not null check (event_type in (
    'lead.created', 'lead.assigned', 'lead.lost', 'conversion.confirmed',
    'payment.confirmed', 'payment.refunded', 'commission.held',
    'commission.eligible', 'commission.approved', 'commission.paid', 'commission.voided'
  )),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  raw_payload jsonb,
  schema_version integer not null default 1 check (schema_version > 0),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source, source_event_id)
);

create index tandem_events_lead_replay_idx
  on tandem.events (workspace_id, lead_id, sequence);

-- Events intentionally do not reference the lead projection, so that the
-- projection can be rebuilt from lead.created without deleting event history.
create function tandem.reject_event_mutation()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  raise exception 'tandem.events is append-only';
end;
$$;
revoke all on function tandem.reject_event_mutation() from public;

create trigger tandem_events_immutable
before update or delete on tandem.events
for each row execute function tandem.reject_event_mutation();
