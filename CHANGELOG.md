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
  `declined`) and operator-only resolution, enforced by RLS. Resolving a
  dispute records the outcome only; it does not yet execute a clawback or
  create a replacement commission.
- A reference dashboard example (`examples/dashboard`, Next.js + shadcn/ui)
  demonstrating a real consumer of the package.

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
