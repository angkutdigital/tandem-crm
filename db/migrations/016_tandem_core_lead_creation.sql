-- Core lead creation is an event plus its rebuildable projection in one
-- transaction. Migration 010 enabled authenticated writers for existing
-- lead projections but intentionally omitted INSERT, which meant an
-- owner/admin could append lead.created and then fail to materialize the
-- projection. Permit that first projection row only to workspace admins.
--
-- An inbound integration that has no human admin identity should continue
-- to use the host's trusted server-side writer. Agents cannot create an
-- unassigned lead through a browser session: that prevents a user from
-- inventing work outside the routing/assignment policy.
create policy tandem_leads_insert on tandem.leads
  for insert
  with check (tandem.is_workspace_admin(workspace_id));

grant insert on tandem.leads to authenticated;
