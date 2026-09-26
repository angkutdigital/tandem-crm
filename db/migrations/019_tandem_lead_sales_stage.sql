-- Promotes sales stage from something visible only inside a Trail activity
-- entry into a first-class, queryable field on the lead itself. Fixes a
-- real conflation: TandemLeadStatus (Automated_Setup -> Won ->
-- Commission_Paid, the commission pipeline) and sales stage (New ->
-- Contacted -> Qualified -> Negotiating -> Closed_Won/Closed_Lost, the
-- sales pipeline) are two different axes that a Kanban view grouped by the
-- former alone, with the latter unqueryable outside individual Trail rows.
--
-- Backfilled from each lead's latest non-retracted trail_entries row where
-- one exists (an agent already recorded a real stage there), defaulting to
-- 'New' for leads with no Trail history. This is a best-effort backfill,
-- not a claim that it reconstructs history exactly -- see src/domain.ts's
-- lead.stage_changed for the event that keeps this column in sync going
-- forward.
alter table tandem.leads
  add column sales_stage text not null default 'New' check (sales_stage in (
    'New', 'Contacted', 'Qualified', 'Negotiating', 'Closed_Won', 'Closed_Lost'
  ));

update tandem.leads l
set sales_stage = latest.sales_stage
from (
  select distinct on (te.workspace_id, te.lead_id)
    te.workspace_id, te.lead_id, te.sales_stage
  from tandem.trail_entries te
  where not te.retracted
  order by te.workspace_id, te.lead_id, te.updated_at desc
) latest
where latest.workspace_id = l.workspace_id and latest.lead_id = l.id;

-- tandem.events' event_type check constraint (002, last extended by 013)
-- was never extended for domain.ts's new lead.stage_changed event: without
-- this, every insert of it is rejected at the database level regardless of
-- any RLS/grant already in place. Same gap, same fix, as 013's comment
-- describes for the three commission.* events it added.
alter table tandem.events drop constraint events_event_type_check;
alter table tandem.events add constraint events_event_type_check check (event_type in (
  'lead.created', 'lead.assigned', 'lead.lost', 'lead.stage_changed', 'conversion.confirmed',
  'payment.confirmed', 'payment.refunded', 'commission.held',
  'commission.eligible', 'commission.approved', 'commission.paid', 'commission.voided',
  'commission.adjusted', 'commission.reinstated', 'commission.clawback_requested'
));
