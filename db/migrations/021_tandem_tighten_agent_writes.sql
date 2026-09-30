-- Tightens what a non-admin (agent) session may write, closing gaps an
-- external pre-launch audit found in 010 and 011. Migrations 010/011 said
-- in their comments that agents could only touch a narrow set of things,
-- but the actual grants and policies were broader than the comments:
--
--   * `grant update on tandem.leads` was table-wide, so an agent could
--     rewrite partner_id, or jump pipeline_status straight to
--     Commission_Eligible on a lead assigned to them.
--   * tandem_payouts_insert let an agent insert a payout with any amount,
--     partner, or status for their own lead.
--   * tandem_disputes_update let an agent resolve their own dispute
--     (status='resolved', outcome='upheld') or set auto_approve_at to a past
--     date so resolve_overdue_disputes() upholds it, contradicting the
--     "partners open, operators resolve" guarantee 011 advertises.
--   * tandem_events_insert let an agent append any event type, including
--     commission.approved/adjusted, to their own lead, and with source
--     'tandem-engine' could pre-claim the idempotency key
--     release_due_commissions() uses, making that scheduled batch throw for
--     every workspace.
--   * a dispute could be opened against a payout that belongs to a
--     different lead, freezing another agent's payout.
--
-- Every restriction below only narrows what `authenticated` non-admins can
-- do. Admins, and trusted schedulers that do not assume the `authenticated`
-- role (release_due_commissions, resolve_overdue_disputes), are unaffected.

-- 1. Events: an agent may only append the lead events the product actually
--    lets them trigger (marking their own lead won/lost, and the sales-stage
--    sync Trail performs). Money events (payment.*, commission.*) and lead
--    assignment are admin/system only. The 'tandem-engine' source is
--    reserved for the scheduled release job.
drop policy tandem_events_insert on tandem.events;
create policy tandem_events_insert on tandem.events
  for insert with check (
    tandem.is_workspace_admin(workspace_id)
    or (
      event_type in ('lead.lost', 'lead.stage_changed', 'conversion.confirmed')
      and source <> 'tandem-engine'
      and lead_id in (
        select id from tandem.leads
        where tandem.leads.workspace_id = tandem.events.workspace_id
          and tandem.leads.assignee_id = tandem.current_agent_id(tandem.events.workspace_id)
      )
    )
  );

-- 2. Payouts are created only when a commission is held, which is an
--    admin/host action. An agent never needs to insert one.
drop policy tandem_payouts_insert on tandem.payouts;
create policy tandem_payouts_insert on tandem.payouts
  for insert with check (tandem.is_workspace_admin(workspace_id));

-- 3. Leads: replace the table-wide UPDATE grant with the projection columns
--    an event append actually moves, and stop a non-admin session from
--    moving pipeline_status anywhere except Won or Lost. (An RLS WITH CHECK
--    cannot compare old to new, so this is a trigger.) Sessions that are not
--    the `authenticated` role (the scheduled release job) skip the check.
revoke update on tandem.leads from authenticated;
grant update (pipeline_status, sales_stage, assignee_id, territory_id, last_event_sequence, updated_at)
  on tandem.leads to authenticated;

create or replace function tandem.guard_lead_status_change()
returns trigger
language plpgsql
as $$
begin
  if current_user::text <> 'authenticated' then
    return new;
  end if;
  if new.pipeline_status is distinct from old.pipeline_status
     and not tandem.is_workspace_admin(new.workspace_id)
     and new.pipeline_status not in ('Won', 'Lost') then
    raise exception 'only a workspace admin can move a lead to %', new.pipeline_status
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger tandem_guard_lead_status_change
  before update on tandem.leads
  for each row execute function tandem.guard_lead_status_change();

-- 4. Disputes: the projection is written only after an operator's
--    dispute_events insert (already admin-only for queried/resolved), so its
--    update is admin-only too. Opening a dispute is still open to the
--    assigned agent, but it must reference a payout that belongs to the same
--    lead, and the opener must be the acting agent.
drop policy tandem_disputes_update on tandem.disputes;
create policy tandem_disputes_update on tandem.disputes
  for update
  using (tandem.is_workspace_admin(workspace_id))
  with check (tandem.is_workspace_admin(workspace_id));

drop policy tandem_disputes_insert on tandem.disputes;
create policy tandem_disputes_insert on tandem.disputes
  for insert
  with check (
    tandem.is_workspace_admin(workspace_id)
    or (
      opened_by_agent_id = tandem.current_agent_id(workspace_id)
      and exists (
        select 1 from tandem.leads l
        where l.workspace_id = tandem.disputes.workspace_id
          and l.id = tandem.disputes.lead_id
          and l.assignee_id = tandem.current_agent_id(tandem.disputes.workspace_id)
      )
      and exists (
        select 1 from tandem.payouts p
        where p.workspace_id = tandem.disputes.workspace_id
          and p.id = tandem.disputes.payout_id
          and p.lead_id = tandem.disputes.lead_id
      )
    )
  );

drop policy tandem_dispute_events_insert on tandem.dispute_events;
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
      and exists (
        select 1 from tandem.payouts p
        where p.workspace_id = tandem.dispute_events.workspace_id
          and p.id = tandem.dispute_events.payout_id
          and p.lead_id = tandem.dispute_events.lead_id
      )
    )
  );
