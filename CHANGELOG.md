# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project has
not yet cut a `1.0.0` release (see the version badge on the landing page or
this repo's [releases page](https://github.com/angkutdigital/tandem-crm/releases)
for the current state).

## [Unreleased]

### Added

- Core: event log, projections, integer money math, idempotency, escrow
  release (`release_due_commissions()`, ready for `pg_cron`), and row-level
  security.
- Portable auth: RLS resolves identity through `tandem.current_user_id()`
  and a vendor-neutral `TandemAuthAdapter`, verified on both Supabase and
  plain Postgres, not just Supabase.
- A migration runner (`applyTandemMigrations`) that tracks applied files in
  `tandem.schema_migrations` and can supersede earlier Supabase-only
  migrations on a fresh install without touching an already-migrated
  production database.
- Lead routing presets (`round_robin`, `least_loaded`, `manual`) via
  `selectAgentForLead()`.
- Ramp: agent onboarding step tracking and certification, with its own
  event log and reducer.
- Coaster: partner-initiated commission disputes (`untracked`, `incorrect`,
  `declined`) and operator-only resolution, enforced by RLS.
- Domain events for acting on an upheld dispute: `commission.adjusted`
  (correct an unpaid commission's amount), `commission.reinstated` (bring a
  voided commission back to `held` with a fresh amount and release date),
  and `commission.clawback_requested` (record money owed back on a
  commission already paid, without Tandem reversing the payment itself).
  `payment.refunded` on an already-paid commission now records a clawback
  instead of refusing the transition. Coaster still only records a dispute's
  outcome; appending one of these three events is a separate step the host
  app takes, matching the "engine never touches money" split everywhere
  else. Wiring these into the `tandem.payouts` projection needs its own
  RLS/grants decision, same open gap as the existing approve/pay/void
  transitions, which also have no `authenticated`-role UPDATE path today.
- A reference dashboard example (`examples/dashboard`, Next.js + shadcn/ui)
  demonstrating a real consumer of the package.
- An automated RLS check (`scripts/ci-rls-check.mjs`) that runs on every
  push and PR against a real Postgres service container: applies every
  migration and asserts cross-tenant isolation actually holds, instead of
  relying on someone re-verifying it by hand each time.

### Fixed

- `withTandemSession` now assumes the `authenticated` role inside its
  transaction. Without this, row-level security was silently bypassed
  entirely for any connection using a role that owns the schema, which is
  the default on most hosted Postgres setups. See the README's Database
  setup section for the one-time grant this requires.
- `authenticated` previously had only `SELECT` on the event log and its
  projections; nothing but the table's owner could actually append an
  event. INSERT/UPDATE grants were added, gated by the same rule the
  existing SELECT policies already used.

### Security

- Migrations 005/006 depended on Supabase-only assumptions (`auth.users`,
  `auth.uid()`, a pre-existing `authenticated` role) that silently broke
  row-level security on any non-Supabase host. Fixed in migration 007.
