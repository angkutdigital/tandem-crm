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
  instead of overclaiming "Live" or underclaiming "Planned". The
  "BetterAuth adapter, Planned" card was swapped for "Auth adapter, Live"
  since bring-your-own-auth already works today via `TandemAuthAdapter`,
  for any provider, not just BetterAuth. The whole page was also
  repositioned from "for Next.js" to "for Postgres" (the engine has zero
  framework dependency; only the example dashboard is Next.js).
- Coaster's first slice, added this session: `src/coaster.ts`, migration
  011, README section, 37 tests. Partner-initiated commission disputes
  (`untracked` / `incorrect` / `declined`, matching how Awin models this),
  operator-only resolution enforced by RLS (not just convention), and the
  actual "brake": `release_due_commissions()` now skips a payout with an
  open or queried dispute. Resolving a dispute only records the outcome
  (upheld/dismissed); it does not create a replacement commission, adjust
  an amount, or execute a clawback on an already-paid commission. See
  "What Coaster does not do yet" below.

In progress, not done:

- `examples/dashboard` only has the shell (sidebar, nav, user switcher)
  and the Overview page. Still missing: Leads (list + kanban + lead
  detail), Agents (detail page beyond what Overview shows), Payouts view,
  Routing settings page. `lib/queries.ts` and `lib/actions.ts` already
  have most of the data functions these pages would need -- check there
  before writing new queries.
- Task list item "Verify dashboard end-to-end in a real browser" is
  pending until the remaining pages exist.

What Coaster does not do yet (in rough priority order for whoever
continues it):

- Executing a resolved dispute: creating a new commission for an
  "untracked, upheld" outcome, adjusting the amount for "incorrect,
  upheld", re-approving for "declined, upheld". Right now the outcome is
  just recorded; nothing acts on it.
- Clawback of a commission that was already paid before the refund/dispute
  happened. `domain.ts`'s `payment.refunded` still explicitly refuses to
  touch a `paid` commission, on purpose; Coaster has no mechanism at all
  for "this was paid, now we need it back."
- A scheduled SQL function that auto-resolves overdue disputes (mirroring
  `release_due_commissions()`); `isDisputeOverdue()` is a pure check only,
  nothing calls it on a schedule.
- Admin-initiated holds unrelated to a partner's own dispute (fraud
  review, compliance), and any dashboard UI for any of this.

Not started:

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

- **A PL/pgSQL `FOR row IN SELECT ...` loop variable is not bound inside
  its own defining query.** `release_due_commissions()`'s loop is
  `for due in select * from tandem.payouts where ... loop`; referencing
  `due.id` inside a correlated subquery *within that same select* (e.g.
  `and not exists (select 1 from tandem.disputes d where d.payout_id =
  due.id ...)`) does not error, but silently resolves to null, so the
  condition is vacuously true and excludes nothing. Found by actually
  running the function against a real disputed payout and watching it get
  released anyway, not by reading the SQL. The fix is to alias the source
  table (`select p.* from tandem.payouts p where ... and not exists
  (select 1 from ... where d.payout_id = p.id ...)`) and correlate to that
  alias instead of the loop variable. If you write another loop like this,
  test it live; this class of bug produces no error at all, in either
  `CREATE FUNCTION` or at call time.
- **DeepSeek will confidently rewrite an existing function from memory
  instead of copying the version you gave it**, even when the brief pastes
  the exact source and says "copy this verbatim, add one condition." When
  asked to extend `release_due_commissions()`, it silently invented a
  different signature (`returns void` instead of `returns table (payout_id
  uuid)`), flipped `security invoker` to `security definer` (a real RLS-
  bypass regression, given this project's whole history with that exact
  class of bug), and referenced columns that don't exist on
  `tandem.payouts` (`due_at`, a `'pending'` status). None of this was
  subtle; it just didn't match the file it was handed. For a change to an
  existing, security-sensitive function, either write the diff yourself or
  read the model's output character-by-character against the original
  before applying it, don't assume "verbatim" in the prompt was followed.

## Suggested next step

Budget is very low as of this checkpoint. Coaster's first slice (schema,
reducer, RLS, the release-function brake) is done, tested, and
live-verified against real Postgres, migration and README updated,
committed and pushed. Do not start executing dispute outcomes, clawback,
the auto-approve scheduler, or the remaining dashboard pages without
checking in with the user first. Ask what to prioritize next.
