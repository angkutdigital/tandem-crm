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

### Known RLS coverage gap

The automated RLS check does not yet cover the full schema or the full write path. It currently covers the core tables: events, payouts, leads, and onboarding. It does not yet cover Ramp, routing, or Coaster tables, and it does not exercise the write side where one agent inserts or updates a row that is not theirs.

Treat those unverified paths accordingly and test them yourself before relying on them. This is an open item, not a hidden bug.

### Data handling

`raw_payload` columns can contain personal data. tandem-crm does not automatically expire or delete this data. Access and retention limits are the integrator's responsibility.

## Explicitly not covered

Vulnerabilities in the following areas are outside the scope of a tandem-crm security report:

- the integrator's own deployment or backend code
- the integrator's chosen Postgres host and its configuration
- the integrator's auth adapter or any code that calls `withTandemSession()`

A compromise of a deployed instance is a compromise of that integrator's infrastructure, not a defect in this package unless it is reproducible from the package's own SQL or TypeScript behavior in an isolated Postgres.

