# Handoff notes

Temporary file, not meant to live in the repo long-term. Delete it once
whoever picks this up next has read it and it's stale.

## What this project is

Two repos, one product:

- **tandem-crm** (this repo): the actual npm package. An embeddable,
  event-sourced partner-attribution and commission-payout engine for
  Postgres, meant to be self-hosted inside someone else's Next.js app.
- **tandem-site**: the marketing/docs site (Astro + Starlight), live in
  production at Cloudflare Pages (merged to `main`).

tandem-crm's PR is still open: https://github.com/angkutdigital/tandem-crm/pull/1
tandem-site's PR merged to `main` and is live in production.

Budget is effectively exhausted as of this checkpoint. This session is
ending; don't start new work here without the user's go-ahead.

## Where things stand

**Core engine:** event log, projections, integer money math, escrow
release, RLS. Verified portable across Supabase and plain Postgres.

**Ramp** (agent onboarding/certification), **lead routing** (round robin /
least loaded / manual), and **Coaster's first slice** (partner-initiated
commission disputes, operator-only resolution via RLS, payout release
blocked while a dispute is open) are all shipped, tested, and
live-verified against real Postgres.

**Dashboard** (`examples/dashboard`, Next.js + shadcn/ui, built on Base UI
not Radix): Overview, Ramp onboarding, **Payouts**, and **Routing
settings** pages all work end to end against a real Postgres database,
each verified in an actual browser render (not just typecheck). Still
missing: **Leads** (list + kanban + lead detail) and an **Agent detail**
page beyond what Overview already shows. `lib/queries.ts` and
`lib/actions.ts` already have most of the data functions these would
need — check there before writing new queries.

**Packaging:** `SECURITY.md` and `CONTRIBUTING.md` added, stating the
real RLS/security model including the known gap below. `CHANGELOG.md`
exists (Keep a Changelog format). An automated cross-tenant RLS check
(`scripts/ci-rls-check.mjs`) runs in CI as the `rls` job against a real
Postgres 16 service container.

**Known gap, stated honestly in SECURITY.md/README, not hidden:** the
automated RLS check covers the core schema (events, payouts, leads,
onboarding) but not yet Ramp/routing/Coaster's own tables, nor the write
side (an agent inserting/updating a row that isn't theirs).

**What Coaster does not do yet**, in rough priority order:

- Executing a resolved dispute: creating a new commission for an
  "untracked, upheld" outcome, adjusting the amount for "incorrect,
  upheld", re-approving for "declined, upheld". Right now the outcome is
  just recorded; nothing acts on it.
- Clawback of a commission that was already paid before the
  refund/dispute happened. `domain.ts`'s `payment.refunded` still
  explicitly refuses to touch a `paid` commission, on purpose.
- A scheduled function that auto-resolves overdue disputes (mirroring
  `release_due_commissions()`); `isDisputeOverdue()` is a pure check
  only, nothing calls it on a schedule.
- Admin-initiated holds unrelated to a partner's own dispute, and any
  dashboard UI for any of Coaster.

**Not started:** npm publish prep beyond what's in `package.json` today
(`files`, dual entry points, `sideEffects: false` are already set), a
full vitest + Playwright run, final copy pass.

## Things that will bite you if you don't know them

- **`examples/dashboard` uses Base UI, not Radix**, even though it's built
  from shadcn/ui. `render={<Link href="/" />}`, not `asChild`.
  `DropdownMenuItem` uses `onClick`, not `onSelect`. A `DropdownMenuLabel`
  needs a `DropdownMenuGroup` ancestor or it throws at runtime.
- **node-postgres returns `bigint` as strings and `timestamptz` as `Date`
  objects.** The query layer in `lib/queries.ts` already normalizes this;
  don't re-add bigint/Date handling in a page component.
- **`withTandemSession` assumes the `authenticated` role.** Whatever
  Postgres role your connection string uses needs
  `grant authenticated to your_role;` once, or RLS silently doesn't apply.
- **Local dev Postgres for the dashboard is not scripted anywhere** — the
  `dashboard_app` role, `tandem_dashboard_dev` database, and grants were
  set up by hand in a disposable instance. A fresh container needs: create
  role/database, run `applyTandemMigrations`, `grant authenticated to
  dashboard_app;`, run `scripts/seed.mjs` with `SEED_DATABASE_URL` as a
  superuser.
- **A PL/pgSQL `FOR row IN SELECT ...` loop variable is not bound inside
  its own defining query.** Alias the source table and correlate to the
  alias, not the loop variable, in any correlated subquery inside that
  same select. This class of bug produces no error at all, ever — test
  loops like this live against real data.
- **DeepSeek will confidently rewrite an existing function from memory**
  instead of copying the version you gave it, even when told "copy this
  verbatim." For any change to existing, security-sensitive code (RLS,
  grants, release/payout logic), read its output character-by-character
  against the original before applying it. It's reliable for new,
  well-specified UI code (the Payouts and Routing settings pages this
  session were both DeepSeek drafts, typechecked clean and live-verified
  with no edits needed) — the risk is specifically in "extend this exact
  existing function" tasks.
- **tandem-crm's `domain.ts` hardcodes `vehicleCount`** as the
  lead-qualification field (a threshold decides automated setup vs.
  manual review). This is a leftover from the original fleet/logistics
  use case this package was extracted from — it isn't a generic
  "qualification metric" field, so it will read strangely to anyone
  adopting this outside logistics. Not fixed this session; flagged here
  since it came up as a real point of confusion.

## Suggested next step

Ask the user before starting anything new. If/when resumed, the
cheapest-to-riskiest remaining items are roughly: Agent detail page →
Leads (list + kanban + detail) → genericizing `vehicleCount` → Coaster's
dispute-execution/clawback layer (security-sensitive, do not hand
straight to DeepSeek — see the note above).
