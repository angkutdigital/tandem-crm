-- Tandem P1 follow-up: grant schema/table privileges to `authenticated`.
--
-- 005 added RLS policies but Postgres checks base GRANTs before it ever
-- consults a row policy: schema tandem was created with
-- `revoke all ... from public` (001_tandem_core.sql), so `authenticated`
-- had no USAGE on the schema at all and every policy in 005 was
-- unreachable ("permission denied for schema tandem"). Caught live: a
-- real end-to-end RLS test (real auth.users rows, real
-- request.jwt.claims) failed at the grant check, not the policy check.
--
-- Row-level filtering is still entirely owned by 005's policies; these
-- grants only open the door those policies then narrow.

grant usage on schema tandem to authenticated;

grant select, update on tandem.workspaces to authenticated;
grant select, insert, update, delete on tandem.members to authenticated;
grant select, insert, update, delete on tandem.agents to authenticated;
grant select, insert, update, delete on tandem.territories to authenticated;
grant select, insert, delete on tandem.agent_territories to authenticated;
grant select, insert, update, delete on tandem.commission_rules to authenticated;

-- leads/events/payouts/payout_ledger have no write policy in 005 (all
-- written by the service-role projection writer), so only SELECT is
-- granted here; an insert/update/delete attempt from `authenticated`
-- should fail at this same grant check, not rely on RLS to block it.
grant select on tandem.leads to authenticated;
grant select on tandem.events to authenticated;
grant select on tandem.payouts to authenticated;
grant select on tandem.payout_ledger to authenticated;
