# Security

## Reporting a vulnerability

Report vulnerabilities privately to **security@angkutdigital.com**.

Please include:

- affected entry point: `tandem-crm` or `tandem-crm/db`
- Postgres version and host type (plain Postgres 16+, Supabase, Neon, RDS)
- migration state, if known
- steps to reproduce

## Supported versions

Only the latest pre-1.0 release is supported. Older pre-1.0 versions do not receive security fixes. There are no backports.

## Security model

tandem-crm is an embeddable engine that runs inside the integrator's own backend and their own Postgres. Angkut Digital Enterprise operates no hosted servers or databases for tandem-crm.

- Row-level security (RLS) enforced in Postgres itself is the cross-tenant boundary. It has been verified against both Supabase and plain Postgres.
- Identity resolves through `tandem.current_user_id()`, which reads the session-local Postgres setting `tandem.user_id`. That setting must be set per-transaction by `withTandemSession()`; it is not trusted from client input.
- A service-role or superuser Postgres credential is required to apply migrations and manage sessions. Keep that credential server-side only. Never bundle it or pass it to client code.
- CI includes an automated RLS check at `scripts/ci-rls-check.mjs`, run against a Postgres 16 service container. It applies every migration and asserts cross-tenant isolation holds.

### What the RLS check covers, and what it does not

The automated check covers every module's tables: core events, payouts, leads and disputes, Ramp onboarding, routing, Trail, and Coaster. It asserts cross-tenant isolation, and it also exercises the write side: what a non-admin agent in the same workspace can and cannot insert or update. For example, an agent cannot insert a payout, rewrite a lead's partner, move a lead's status to a money state, resolve their own dispute, or append a commission event. Each of those assertions was confirmed to fail against the schema before migration 021 tightened it.

What it does not do:

- Row-level security decides who may write a row. It does not prove that a projection row matches the event log it was built from. Keeping those in step is the writer's job (validate with the reducer, then write both in one transaction), and a writer that bypasses the reducer can still create a mismatch. Rebuilding a projection from events is the recovery path.
- Money movement is enforced at the application layer as well as in Postgres: `tandem-camp` and the reference dashboard require an owner or admin to approve or pay a commission, and read the partner, amount and currency from the event log rather than from the request. If you write your own admin actions, do the same.
- Since 0.2, `appendLeadEvents` in `tandem-crm/db` is the writer the package ships: it locks the lead, replays, reads back the real sequence and checks every row count. Its optional `actor` argument applies the agent rules in the app as well as in the database. A writer that skips it can still put the projection out of step with the log.
- Payment webhooks (`recordPayment`, `recordRefund`) must run as a workspace owner or admin identity. A session with no user, or an agent, is refused by the database.
- `commission.transferred` is admin-only and can move an unpaid line to any account id, labelled as the house account. Every transfer is kept in the event history with its reason. Treat the right to deactivate partners as a money permission.
- The check runs against the schema this repository ships. If you add tables or grants of your own, they are outside it.

### Data handling

`raw_payload` columns can contain personal data. tandem-crm does not automatically expire or delete this data. Access and retention limits are the integrator's responsibility.

## Explicitly not covered

Vulnerabilities in the following areas are outside the scope of a tandem-crm security report:

- the integrator's own deployment or backend code
- the integrator's chosen Postgres host and its configuration
- the integrator's auth adapter or any code that calls `withTandemSession()`

A compromise of a deployed instance is a compromise of that integrator's infrastructure, not a defect in this package unless it is reproducible from the package's own SQL or TypeScript behavior in an isolated Postgres.

