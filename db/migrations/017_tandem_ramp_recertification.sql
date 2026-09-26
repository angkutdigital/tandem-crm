-- A workspace can add a required onboarding step after an agent is already
-- certified. Preserve the certification fact, but let an admin explicitly
-- reopen the lifecycle so the agent can complete the new requirement and
-- recertify. This is an audit-preserving state transition, not a deletion.
alter table tandem.agent_events drop constraint agent_events_event_type_check;
alter table tandem.agent_events add constraint agent_events_event_type_check check (event_type in (
  'onboarding.started', 'onboarding.step_completed', 'onboarding.certified',
  'onboarding.reopened'
));

-- Migration 010 made normal onboarding writes available to the app session.
-- Keep self-service start/step/certify intact, but do not let an agent reopen
-- their own certification after requirements changed: that administrative
-- decision belongs to the workspace owner/admin.
drop policy tandem_agent_events_insert on tandem.agent_events;
create policy tandem_agent_events_insert on tandem.agent_events
  for insert with check (
    tandem.is_workspace_admin(workspace_id)
    or (
      event_type in ('onboarding.started', 'onboarding.step_completed', 'onboarding.certified')
      and agent_id = tandem.current_agent_id(workspace_id)
    )
  );
