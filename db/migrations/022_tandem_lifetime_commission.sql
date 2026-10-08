-- Lifetime commission (0.2). A lead can now hold many payments, each with
-- at most one commission line. See docs/design-0.2-lifetime-commission.md.
--
-- No RLS policy changes: since 021, an agent may append only lead.lost,
-- lead.stage_changed and conversion.confirmed, and payout inserts/updates
-- are admin-only. Every new event type below is therefore admin-only too.

-- 1. The three new event types.
alter table tandem.events drop constraint events_event_type_check;
alter table tandem.events add constraint events_event_type_check check (event_type in (
  'lead.created', 'lead.assigned', 'lead.lost', 'lead.stage_changed', 'conversion.confirmed',
  'payment.confirmed', 'payment.refunded', 'commission.held',
  'commission.eligible', 'commission.approved', 'commission.paid', 'commission.voided',
  'commission.adjusted', 'commission.reinstated', 'commission.clawback_requested',
  'commission.forfeited', 'commission.transferred', 'commission.clawback_recovered'
));

-- 2. Payout rows are now commission lines. Every column mirrors a field the
--    reducer keeps on CommissionState, so the projection stays rebuildable.
alter table tandem.payouts
  add column payment_id text check (payment_id is null or length(btrim(payment_id)) > 0),
  add column beneficiary text not null default 'partner' check (beneficiary in ('partner', 'house')),
  add column original_partner_id text,
  add column beneficiary_reason text,
  add column basis_points integer check (basis_points is null or basis_points between 0 and 10000),
  add column customer_age_months integer check (customer_age_months is null or customer_age_months >= 0),
  add column clawback_recovered_minor bigint not null default 0;

-- 0.1 rows: the referrer is the partner, and the payment id is the one the
-- reducer derives for a 0.1 payment ("legacy:" + its event id). A 0.1 lead
-- has at most one payment.confirmed event.
update tandem.payouts set original_partner_id = partner_id where original_partner_id is null;
update tandem.payouts p
set payment_id = 'legacy:' || e.id::text
from tandem.events e
where p.payment_id is null
  and e.workspace_id = p.workspace_id
  and e.lead_id = p.lead_id
  and e.event_type = 'payment.confirmed';

-- A host that still inserts payout rows the 0.1 way (no original_partner_id)
-- keeps working: the referrer defaults to the partner on the row.
create function tandem.default_payout_original_partner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.original_partner_id is null then
    new.original_partner_id := new.partner_id;
  end if;
  return new;
end;
$$;
revoke all on function tandem.default_payout_original_partner() from public;

create trigger tandem_payouts_default_original_partner
  before insert on tandem.payouts
  for each row execute function tandem.default_payout_original_partner();

alter table tandem.payouts alter column original_partner_id set not null;
alter table tandem.payouts add constraint tandem_payouts_original_partner_not_blank
  check (length(btrim(original_partner_id)) > 0);
alter table tandem.payouts add constraint tandem_payouts_house_names_referrer
  check (beneficiary = 'partner' or original_partner_id <> partner_id);
alter table tandem.payouts add constraint tandem_payouts_recovered_within_clawback
  check (clawback_recovered_minor >= 0 and clawback_recovered_minor <= coalesce(clawback_amount_minor, 0));

-- One line per payment, even if a writer is wrong.
create unique index tandem_payouts_one_line_per_payment
  on tandem.payouts (workspace_id, lead_id, payment_id)
  where payment_id is not null;

create index tandem_payouts_lead_idx on tandem.payouts (workspace_id, lead_id);
create index tandem_payouts_partner_open_idx on tandem.payouts (workspace_id, partner_id)
  where status in ('held', 'eligible', 'approved');

-- 3. release_due_commissions(): with many lines, the lead may already be
--    Commission_Eligible because of another line. The derived status after
--    any line becomes eligible is Commission_Eligible (domain.ts
--    deriveLeadStatus), so accept either starting state. Unchanged otherwise
--    from 011 (skips lines under an open dispute, locks with skip locked,
--    raises on a duplicate eligibility event).
create or replace function tandem.release_due_commissions()
returns table (payout_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  due tandem.payouts%rowtype;
  eligible_event_id uuid;
  eligible_event_sequence bigint;
begin
  for due in
    select p.* from tandem.payouts p
    where p.status = 'held' and p.release_at <= now()
      and not exists (
        select 1 from tandem.disputes d
        where d.payout_id = p.id and d.status in ('open', 'queried')
      )
    order by p.release_at, p.id
    for update skip locked
  loop
    insert into tandem.events (
      workspace_id, entity_type, entity_id, lead_id, source, source_event_id,
      event_type, payload, occurred_at
    ) values (
      due.workspace_id, 'payout', due.id, due.lead_id, 'tandem-engine',
      'payout:' || due.id::text || ':eligible', 'commission.eligible',
      pg_catalog.jsonb_build_object('payoutId', due.id), now()
    )
    on conflict (workspace_id, source, source_event_id) do nothing
    returning id, sequence into eligible_event_id, eligible_event_sequence;

    if eligible_event_id is null then
      raise exception 'held payout % already has an eligibility event', due.id;
    end if;

    update tandem.payouts
    set status = 'eligible', last_event_id = eligible_event_id, updated_at = now()
    where id = due.id and workspace_id = due.workspace_id;

    update tandem.leads
    set pipeline_status = 'Commission_Eligible',
        last_event_sequence = eligible_event_sequence,
        updated_at = now()
    where id = due.lead_id and workspace_id = due.workspace_id
      and pipeline_status in ('Commission_Hold', 'Commission_Eligible');
    if not found then
      raise exception 'lead projection for payout % is not on commission hold', due.id;
    end if;

    insert into tandem.payout_ledger (
      workspace_id, payout_id, event_id, from_status, to_status
    ) values (
      due.workspace_id, due.id, eligible_event_id, 'held', 'eligible'
    );
    payout_id := due.id;
    return next;
  end loop;
end;
$$;
revoke all on function tandem.release_due_commissions() from public;
