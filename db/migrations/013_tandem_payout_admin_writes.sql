-- 010 gave `authenticated` INSERT on tandem.payouts and UPDATE on
-- tandem.leads/tandem.agent_onboarding_status, but never UPDATE on
-- tandem.payouts itself or INSERT on tandem.payout_ledger. That means no
-- app-layer writer running as `authenticated` can actually move a payout
-- through approved/paid/voided, or apply any of domain.ts's newer
-- commission.adjusted/reinstated/clawback_requested transitions -- only a
-- role bypassing RLS entirely (or release_due_commissions(), which is its
-- own security-invoker function called by a trusted scheduler, not an
-- interactive admin) can touch these rows today. This closes that gap for
-- the interactive case: an operator approving, paying, voiding, adjusting,
-- reinstating, or clawing back a commission from an admin action in your
-- own app.
--
-- Admin-only, unlike leads/agent_onboarding_status: an agent should never
-- be able to approve or pay out their own commission, so there is no
-- "assignee_id = current_agent_id" branch here, only tandem.is_workspace_admin.
-- As with every other write policy in this schema, the row-level check is
-- the only enforcement; validating that a specific transition (e.g. you
-- can't adjust an already-paid commission) is legal is domain.ts's job,
-- done by the writer before it ever issues this UPDATE.

-- tandem.events' event_type check constraint (002) was never extended for
-- the three new domain.ts event types added alongside this migration
-- (commission.adjusted, commission.reinstated, commission.clawback_requested):
-- without this, every insert of one of them would be rejected at the
-- database level regardless of any RLS/grant change above.
alter table tandem.events drop constraint events_event_type_check;
alter table tandem.events add constraint events_event_type_check check (event_type in (
  'lead.created', 'lead.assigned', 'lead.lost', 'conversion.confirmed',
  'payment.confirmed', 'payment.refunded', 'commission.held',
  'commission.eligible', 'commission.approved', 'commission.paid', 'commission.voided',
  'commission.adjusted', 'commission.reinstated', 'commission.clawback_requested'
));

alter table tandem.payouts
  add column clawback_amount_minor bigint,
  add column clawback_reason text,
  add column clawback_requested_at timestamptz;

alter table tandem.payouts
  add constraint tandem_payouts_clawback_all_or_nothing check (
    (clawback_amount_minor is null and clawback_reason is null and clawback_requested_at is null)
    or (clawback_amount_minor > 0 and clawback_amount_minor <= amount_minor
        and clawback_reason is not null and length(btrim(clawback_reason)) > 0
        and clawback_requested_at is not null)
  );

create policy tandem_payouts_update on tandem.payouts
  for update using (tandem.is_workspace_admin(workspace_id))
  with check (tandem.is_workspace_admin(workspace_id));

grant update on tandem.payouts to authenticated;

create policy tandem_payout_ledger_insert on tandem.payout_ledger
  for insert with check (tandem.is_workspace_admin(workspace_id));

grant insert on tandem.payout_ledger to authenticated;
