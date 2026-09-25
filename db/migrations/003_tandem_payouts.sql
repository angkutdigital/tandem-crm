-- Current payout state is a projection; event history and this ledger are append-only.
create table tandem.payouts (
  id uuid primary key,
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  lead_id uuid not null,
  partner_id text not null check (length(btrim(partner_id)) > 0),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  hold_days integer not null check (hold_days >= 0),
  payment_confirmed_at timestamptz not null,
  release_at timestamptz not null check (release_at >= payment_confirmed_at),
  status text not null check (status in ('held', 'eligible', 'approved', 'paid', 'voided')),
  last_event_id uuid not null,
  approved_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, last_event_id) references tandem.events(workspace_id, id) on delete restrict
);

create index tandem_payouts_due_idx
  on tandem.payouts (release_at, id)
  where status = 'held';

create table tandem.payout_ledger (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  payout_id uuid not null,
  event_id uuid not null,
  from_status text,
  to_status text not null check (to_status in ('held', 'eligible', 'approved', 'paid', 'voided')),
  recorded_at timestamptz not null default now(),
  unique (workspace_id, event_id),
  foreign key (workspace_id, payout_id) references tandem.payouts(workspace_id, id) on delete restrict,
  foreign key (workspace_id, event_id) references tandem.events(workspace_id, id) on delete restrict
);

create trigger tandem_payout_ledger_immutable
before update or delete on tandem.payout_ledger
for each row execute function tandem.reject_event_mutation();
