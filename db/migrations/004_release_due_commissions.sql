-- Draft only. A trusted database scheduler role may call this function after
-- its privileges are reviewed. No cron job or public API grant is installed.
-- Refund handling must void the payout in the same transaction as its event.
create function tandem.release_due_commissions()
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
    select * from tandem.payouts
    where status = 'held' and release_at <= now()
    order by release_at, id
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
      and pipeline_status = 'Commission_Hold';
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
