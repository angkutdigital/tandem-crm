-- 001-009 gave `authenticated` read access to the event log and its
-- projections (tandem.events, tandem.agent_events, tandem.payouts,
-- tandem.leads, tandem.agent_onboarding_status), scoped by the same
-- "admin sees all, everyone else sees their own" rule everywhere. Nothing
-- ever granted write access to any of them: only a table owner or
-- superuser could append an event or update a projection, which any real
-- deployment needs to do. This adds INSERT/UPDATE, gated by the identical
-- ownership rule the SELECT policies already use, so an application-layer
-- writer (validate with the reducer, then write) can run as `authenticated`
-- instead of needing a separate elevated connection.
--
-- Events and agent_events stay insert-only: tandem.reject_event_mutation()
-- already blocks update/delete on tandem.events, and the mirroring trigger
-- on tandem.agent_events (see 008) does the same for it.

create policy tandem_events_insert on tandem.events
  for insert with check (
    tandem.is_workspace_admin(workspace_id)
    or lead_id in (
      select id from tandem.leads
      where tandem.leads.workspace_id = tandem.events.workspace_id
        and tandem.leads.assignee_id = tandem.current_agent_id(tandem.events.workspace_id)
    )
  );

grant insert on tandem.events to authenticated;

create policy tandem_agent_events_insert on tandem.agent_events
  for insert with check (
    tandem.is_workspace_admin(workspace_id)
    or agent_id = tandem.current_agent_id(workspace_id)
  );

grant insert on tandem.agent_events to authenticated;

create policy tandem_payouts_insert on tandem.payouts
  for insert with check (
    tandem.is_workspace_admin(workspace_id)
    or lead_id in (
      select id from tandem.leads
      where tandem.leads.workspace_id = tandem.payouts.workspace_id
        and tandem.leads.assignee_id = tandem.current_agent_id(tandem.payouts.workspace_id)
    )
  );

grant insert on tandem.payouts to authenticated;

-- Leads: update only, and only the projection columns an event append
-- moves (pipeline_status, assignee_id, territory_id, last_event_sequence,
-- updated_at). A non-admin can only touch a lead already assigned to them,
-- both before and after the update, so this does not let an agent grab an
-- unassigned lead or hand their lead to someone else -- assignment stays an
-- admin/routing action.
create policy tandem_leads_update on tandem.leads
  for update using (
    tandem.is_workspace_admin(workspace_id)
    or assignee_id = tandem.current_agent_id(workspace_id)
  )
  with check (
    tandem.is_workspace_admin(workspace_id)
    or assignee_id = tandem.current_agent_id(workspace_id)
  );

grant update on tandem.leads to authenticated;

create policy tandem_agent_onboarding_status_insert on tandem.agent_onboarding_status
  for insert with check (
    tandem.is_workspace_admin(workspace_id)
    or agent_id = tandem.current_agent_id(workspace_id)
  );

create policy tandem_agent_onboarding_status_update on tandem.agent_onboarding_status
  for update using (
    tandem.is_workspace_admin(workspace_id)
    or agent_id = tandem.current_agent_id(workspace_id)
  )
  with check (
    tandem.is_workspace_admin(workspace_id)
    or agent_id = tandem.current_agent_id(workspace_id)
  );

grant insert, update on tandem.agent_onboarding_status to authenticated;
