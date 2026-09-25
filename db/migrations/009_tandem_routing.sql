-- Stores which auto-assignment preset a workspace uses for new leads. The table
-- holds only explicit overrides: the absence of a row means the round_robin
-- default. Tandem stores the setting and computes the recommended agent with a
-- pure function in application code; it does not perform the assignment itself,
-- the same pattern Core uses everywhere else.
create table tandem.routing_settings (
  workspace_id uuid primary key references tandem.workspaces(id) on delete restrict,
  strategy text not null default 'round_robin' check (strategy in ('round_robin', 'least_loaded', 'manual')),
  updated_at timestamptz not null default now()
);

alter table tandem.routing_settings enable row level security;

create policy tandem_routing_settings_select on tandem.routing_settings
  for select using (tandem.current_role(workspace_id) is not null);

create policy tandem_routing_settings_admin_insert on tandem.routing_settings
  for insert with check (tandem.is_workspace_admin(workspace_id));

create policy tandem_routing_settings_admin_update on tandem.routing_settings
  for update using (tandem.is_workspace_admin(workspace_id))
  with check (tandem.is_workspace_admin(workspace_id));

create policy tandem_routing_settings_admin_delete on tandem.routing_settings
  for delete using (tandem.is_workspace_admin(workspace_id));

grant select, insert, update, delete on tandem.routing_settings to authenticated;
