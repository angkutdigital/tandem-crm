-- Coaster's timed resolution contract. A trusted scheduler (the host's
-- cron, serverless scheduled function, or database scheduler) invokes this
-- periodically. Tandem does not install a cron job or choose a vendor.
--
-- The deadline is stored on dispute.opened, so this never reinterprets a
-- workspace policy after the fact. "auto approve" is deliberately an
-- upheld dispute outcome only; applying a commission adjustment/reinstatement
-- remains an explicit host/operator decision after resolution.
create function tandem.resolve_overdue_disputes()
returns table (dispute_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  due tandem.disputes%rowtype;
  resolved_event_id uuid;
  resolved_event_sequence bigint;
begin
  for due in
    select d.* from tandem.disputes d
    where d.status in ('open', 'queried')
      and d.auto_approve_at <= now()
    order by d.auto_approve_at, d.id
    for update skip locked
  loop
    insert into tandem.dispute_events (
      workspace_id, dispute_id, lead_id, payout_id, source, source_event_id,
      event_type, payload, occurred_at
    ) values (
      due.workspace_id, due.id, due.lead_id, due.payout_id,
      'tandem-engine', 'dispute:' || due.id::text || ':overdue-upheld',
      'dispute.resolved',
      pg_catalog.jsonb_build_object(
        'outcome', 'upheld',
        'note', 'Automatically upheld after the response window elapsed'
      ),
      now()
    )
    on conflict (workspace_id, source, source_event_id) do nothing
    returning id, sequence into resolved_event_id, resolved_event_sequence;

    -- A conflict means an earlier scheduler run already owns the immutable
    -- resolution fact, so leave its projection untouched.
    if resolved_event_id is null then
      continue;
    end if;

    update tandem.disputes
    set status = 'resolved',
        outcome = 'upheld',
        resolution_note = 'Automatically upheld after the response window elapsed',
        last_event_sequence = resolved_event_sequence,
        updated_at = now()
    where id = due.id and workspace_id = due.workspace_id;

    dispute_id := due.id;
    return next;
  end loop;
end;
$$;

-- No public grant: a host must explicitly give a reviewed, trusted scheduler
-- role permission to execute this invoker-rights function.
revoke all on function tandem.resolve_overdue_disputes() from public;
