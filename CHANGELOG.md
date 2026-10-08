# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project has
not yet cut a `1.0.0` release (see the version badge on the landing page or
this repo's [releases page](https://github.com/angkutdigital/tandem-crm/releases)
for the current state).

## [Unreleased]

## [0.2.0] - 2026-10-08

Lifetime commission. A subscription customer pays every month, and the partner who referred them now earns a commission on every payment. See `docs/design-0.2-lifetime-commission.md`.

### Added

- Many payments per lead, each with its own commission line, hold, approval and payout. `payment.confirmed` takes a `paymentId` so a retried webhook is harmless.
- Rates by customer age (`commission.rateSchedule`), measured in whole calendar months from the first payment. Each line saves its rate and the customer's age.
- Partial refunds (`payment.refunded` with `paymentId` and `amountMinor`). Unpaid lines shrink in proportion; paid lines get a clawback.
- Clawbacks are a running total per line, capped at the paid amount. New `commission.clawback_recovered` records money recovered.
- House account. `partners.onDeactivation` decides what happens to a deactivated partner's unpaid lines and future payments. New `commission.transferred` and `commission.forfeited` events.
- Pure helpers: `planPaymentCommission`, `planPartnerDeactivation`, `partnerBalance`, `customerAgeMonths`, `rateForCustomerAge`.
- A writer in `tandem-crm/db`: `appendLeadEvents`, `recordPayment`, `recordRefund`, `deactivatePartner`, plus `loadLeadState`. Camp and the reference dashboard now use it instead of their own copies.
- Migration 022: commission-line columns on `tandem.payouts`, one line per payment enforced by a unique index, the new event types, and a release job that handles many lines per lead.
- Camp's Payouts view shows each line's payment, rate, who it is owed to, and any clawback still owed.
- `lead.partner_attributed` and `attributePartner()`: attach the referring partner to a lead created without one, such as any 0.1 lead (0.1 kept the partner on the commission, not on the lead). Admin-only, once per lead, refused if an existing commission line names a different partner. Camp's New lead form has an optional "Referred by partner" field.
- `commission.skipped`: when a payment arrives for a lead with no partner, or its commission would round to zero, `recordPayment` records why there is no line instead of writing nothing.

### Changed

- `LeadState` has `payments` and `commissions` lists. The old `payment` and `commission` fields remain as the most recent of each, for compatibility.
- A second `commission.clawback_requested` on the same line now adds to the first instead of being rejected.
- `TandemPayoutAdapter.executePayout` also receives `beneficiary` and `paymentId`.
- A lead earns commission only if it has a partner. Leads created before this release, and leads created in Camp without "Referred by partner", earn nothing until a partner is attached.
- Only the release job may release a line. The writer refuses `commission.eligible`, and the database now refuses it, and the "tandem-engine" source, from any authenticated session, admins included. The writer also refuses events stamped more than five minutes in the future.
- Camp and the reference dashboard refuse to pay a house-account line, and Camp shows it as "House" with no Pay action.
- `tandem.leads.partner_id` is kept in step by the writer. Only an admin can change it.

### Fixed (found by the pre-release audit)

- The release job could stop for every workspace. Its idempotency key was fixed per line, so a line released, voided and reinstated raised "already has an eligibility event" on its second release, and the whole run failed. The key now names the event that put the line on hold. This key existed in 0.1 too; 0.2's `heldLines: "void"` policy made it easy to reach.
- An admin could end a hold early by stamping `commission.eligible` with a future time.
- The 0.1 compatibility test took longer than the default test timeout and now has its own.

### Compatibility

- Every 0.1 history replays to the same state. This is tested against a frozen copy of the 0.1 reducer over 3,000 random histories.
- Payout rows inserted the 0.1 way keep working: the referrer defaults to the row's partner.

## [0.1.0] - 2026-09-27

### Added

- `tandem-camp/styles.css`: one stylesheet a host imports after Tailwind
  (`@import "tandem-camp/styles.css";`). Without it, Camp rendered with no
  layout in any app other than this repo's own dashboard, because Tailwind
  skips `node_modules` and the dashboard only looked right by sharing class
  names with Camp. The stylesheet scans Camp's compiled components, defines
  the data-attribute variants they use, and sets default colors scoped to a
  `.tandem-camp` class, so it stays readable whatever theme the host already
  has. Found by installing the packed tarballs into a fresh Next.js app.
- `tandem-camp`: the installable admin package (`packages/camp`) now has
  every planned screen migrated from the reference dashboard and
  live-verified against real Postgres -- Overview (manager and per-agent
  views), Leads (list, kanban board, detail, full Trail/CHAMP activity),
  Agents, Payouts, Earnings, Disputes, and Settings (workspace setup,
  Waypoint routing strategy). Bumped to `0.1.0` alongside `tandem-crm`;
  `private: true` removed and `tandem-crm` is now a real `^0.1.0`
  dependency instead of a workspace-only `file:../..` path, so both
  packages are ready for `npm publish`.
- Trail: CHAMP qualification (Challenges, Authority, Money, Prioritization)
  as four new optional text fields on a visit report, alongside a new
  `whatsapp` channel option. All five text fields (the pre-existing `note`
  included) are now optional at both the domain-reducer and database
  level, with a single check that at least one of the five has content --
  a deliberately backward-compatible schema change so replaying every
  pre-existing (pre-CHAMP) event still works unchanged. See migration
  `020_tandem_trail_champ.sql` and `src/trail.ts`'s module comment for the
  full reasoning.

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

An independent pre-release audit found the following, all fixed before the first publish:

- Camp and the reference dashboard trusted the browser for money movement.
  `payCommission` sent whatever partner, amount and currency the caller
  supplied, before checking who was calling or what state the payout was in,
  and two simultaneous calls could pay the same payout twice. It now requires
  an owner or admin, locks the lead, requires the commission to be exactly
  "approved", and reads the partner, amount and currency from the event log.
- Approving, adjusting or clawing back a commission had no role check; an
  agent could record their own payout approval in the event log. All
  commission and dispute-operator actions now require an owner or admin.
- Row-level security was broader than its comments claimed (migration 021):
  an agent could insert a payout with any amount, rewrite a lead's partner or
  jump its status to a money state, resolve their own dispute, append commission
  events, claim the reserved `tandem-engine` event source (which could make the
  scheduled release job fail for every workspace), or open a dispute against
  another lead's payout. Each is now blocked, with a regression assertion in
  the RLS suite.
- Concurrent appends to one lead could both pass validation and write a
  duplicate transition, leaving a history that can never be replayed again.
  Appends now lock the lead row first. `last_event_sequence` is also now the
  real database sequence rather than a locally computed guess, and every
  projection update checks its row count so a filtered update fails loudly
  instead of silently disagreeing with the log.
- `tandem-camp` now ships its `LICENSE`.
