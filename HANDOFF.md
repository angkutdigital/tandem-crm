# Handoff notes

Temporary file. Delete this once whoever picks up the work is caught up
(or once the same session that wrote it finishes the remaining scope).
Not meant to live in the repo long-term.

## What this project is

Two repos, one product:

- **tandem-crm** (this repo): the actual npm package. An embeddable,
  event-sourced partner-attribution and commission-payout engine for
  Postgres, meant to be self-hosted inside someone else's Next.js app.
- **tandem-site**: the marketing/docs site (Astro + Starlight).

Both repos are on branch `claude/lucid-feynman-gshz88`, each with one
open PR:

- tandem-crm: https://github.com/angkutdigital/tandem-crm/pull/1
- tandem-site: https://github.com/angkutdigital/tandem-site/pull/1

The person driving this (the user) is working with a limited AI budget
and has asked to move carefully with it. Don't rebuild/restart things
repeatedly hunting for bugs one at a time; batch checks, read the actual
error before guessing, and check in before starting something open-ended
like a new module.

## Where things actually stand

Done and pushed:

- Core engine: event log, projections, integer money math, escrow release,
  RLS. Verified portable across Supabase and plain Postgres (this was a
  real fixed bug: `auth.uid()` was hardcoded and broke on Neon/RDS/etc).
- Migration runner (`applyTandemMigrations`) with a `-- tandem:supersedes`
  convention so newer migrations can fully replace Supabase-only ones on
  fresh installs without touching already-applied history.
- Ramp (agent onboarding + certification): `src/ramp.ts`, migration 008,
  tests, README section. Shipped and working.
- Lead routing presets (round robin / least loaded / manual) added to
  Core: `src/routing.ts`, migration 009.
- A reference dashboard example at `examples/dashboard/` (Next.js +
  shadcn/ui). The Overview page and the full Ramp onboarding flow
  (complete a step, self-certify) work end to end against a real
  Postgres database, verified in an actual browser, not just reviewed.
- Migration 010, added this session: `authenticated` previously had only
  `SELECT` on the event log and its projections (`tandem.events`,
  `tandem.agent_events`, `tandem.payouts`, `tandem.leads`,
  `tandem.agent_onboarding_status`) -- nothing but the table owner could
  actually append an event. This was a real gap in the shipped package,
  not just a dashboard-local config issue. Fixed with INSERT/UPDATE
  grants gated by the same admin-or-own-row rule the SELECT policies
  already used.
- tandem-site landing page copy updated: Ramp and Core now correctly show
  "Live" in the roadmap and the hero sidebar (was stuck on "Planned" from
  before Ramp existed). CRM/Admin UI shows a new "In progress" status
  instead of overclaiming "Live" or underclaiming "Planned".

In progress, not done:

- `examples/dashboard` only has the shell (sidebar, nav, user switcher)
  and the Overview page. Still missing: Leads (list + kanban + lead
  detail), Agents (detail page beyond what Overview shows), Payouts view,
  Routing settings page. `lib/queries.ts` and `lib/actions.ts` already
  have most of the data functions these pages would need -- check there
  before writing new queries.
- Task list item "Verify dashboard end-to-end in a real browser" is
  pending until the remaining pages exist.

Not started:

- Coaster (clawbacks, disputes, payout blocking).
- Final landing-page pass, packaging (SECURITY.md, CONTRIBUTING.md, npm
  publish prep, CI-automated RLS test), final vitest + Playwright run.

## Things that will bite you if you don't know them

- **`examples/dashboard` uses Base UI, not Radix**, even though it's
  built from shadcn/ui. The prop is `render={<Link href="/" />}`, not
  `asChild`. `DropdownMenuItem` uses `onClick`, not `onSelect`. A
  `DropdownMenuLabel` (`Menu.GroupLabel`) needs a `DropdownMenuGroup`
  ancestor or it throws at runtime, not build time. If you're
  drafting new dashboard components with an LLM, tell it this
  explicitly or it will write Radix-shaped code that only fails once
  you click it in a real browser.
- **node-postgres returns `bigint` columns as strings and `timestamptz`
  columns as `Date` objects**, not numbers/ISO strings. `sequence` on
  every event table is `bigint`. If you read events back out to replay
  them through a reducer (`replayLeadEvents`, `replayAgentOnboardingEvents`),
  you must `Number(row.sequence)` and `new Date(row.occurred_at).toISOString()`
  or the reducer's own validation throws confusingly ("event id and
  positive sequence are required", "timestamp must be an ISO 8601
  instant"). See `lib/actions.ts`'s `loadLeadEvents`/`loadAgentEvents`
  and `lib/queries.ts`'s `toISO()` helper.
- **`withTandemSession` assumes the `authenticated` role.** Whatever
  Postgres role your connection string uses needs
  `grant authenticated to your_role;` run once, or every query silently
  runs with RLS bypassed (if that role owns the schema) instead of
  failing loudly. This is documented in the README's Database setup
  section.
- **A middleware-set cookie is not visible to the same request's Server
  Components.** `middleware.ts` sets a default demo-user cookie for the
  *next* request; the current render still sees no cookie. The fix used
  here: `lib/auth.ts`'s `getCurrentUserId()` falls back to the same
  default identity itself, rather than relying on request-forwarding
  tricks that turned out not to work reliably in this Next.js version.
- **Local dev Postgres setup for the dashboard is not scripted anywhere.**
  The `dashboard_app` role, the `tandem_dashboard_dev` database, and the
  grants were all set up by hand during this session and only exist in
  that one disposable Postgres instance. If this session's container
  goes away, a fresh one needs: create the role and database, run
  `applyTandemMigrations`, `grant authenticated to dashboard_app;`, run
  `scripts/seed.mjs` (needs `SEED_DATABASE_URL` as a superuser, since the
  seed script writes directly into the event tables the way a real
  projection writer would -- see the comment in `.env.local`). This
  should probably become a checked-in setup script at some point; it
  isn't one yet.

## Suggested next step

Given the budget concern raised this session: don't start Coaster or the
remaining dashboard pages without checking in first. The natural
checkpoint is right here -- Overview page done and verified, roadmap copy
accurate. Ask what to prioritize with what's left.
