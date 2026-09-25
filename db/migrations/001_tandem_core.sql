-- Local draft only. Review roles, privileges, RLS and projection writers before applying.
-- Private schema: do not add it to PostgREST exposed schemas.
create schema if not exists tandem;
revoke all on schema tandem from public;
alter default privileges in schema tandem revoke all on tables from public;
alter default privileges in schema tandem revoke all on functions from public;

create table tandem.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (length(btrim(slug)) > 0),
  created_at timestamptz not null default now()
);

-- Configuration is ordinary mutable CRUD. Auth identity mapping comes later.
create table tandem.agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  display_name text not null check (length(btrim(display_name)) > 0),
  external_ref text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, external_ref)
);

create table tandem.territories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  name text not null check (length(btrim(name)) > 0),
  code text not null,
  active boolean not null default true,
  unique (workspace_id, id),
  unique (workspace_id, code)
);

create table tandem.agent_territories (
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  agent_id uuid not null,
  territory_id uuid not null,
  primary key (workspace_id, agent_id, territory_id),
  foreign key (workspace_id, agent_id) references tandem.agents(workspace_id, id) on delete cascade,
  foreign key (workspace_id, territory_id) references tandem.territories(workspace_id, id) on delete cascade
);

create table tandem.commission_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  product_tag text not null,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  basis_points integer not null check (basis_points between 0 and 10000),
  hold_days integer not null default 30 check (hold_days >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, product_tag, currency)
);

-- Rebuildable projection. Dynamic lead data is JSON, never columns invented per source.
create table tandem.leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references tandem.workspaces(id) on delete restrict,
  company_name text not null,
  contact_phone text,
  vehicle_count integer not null check (vehicle_count >= 0),
  partner_id text,
  product_tag text,
  attributes jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  pipeline_status text not null check (pipeline_status in (
    'Automated_Setup', 'Manual_Review', 'Won', 'Commission_Hold',
    'Commission_Eligible', 'Commission_Paid', 'Lost', 'Refunded'
  )),
  assignee_id uuid,
  territory_id uuid,
  last_event_sequence bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, assignee_id) references tandem.agents(workspace_id, id) on delete restrict,
  foreign key (workspace_id, territory_id) references tandem.territories(workspace_id, id) on delete restrict
);

create index tandem_leads_workspace_status_idx
  on tandem.leads (workspace_id, pipeline_status, updated_at desc);
