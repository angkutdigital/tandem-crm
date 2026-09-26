# Handoff notes

Temporary file, not meant to live in the repo long-term. Delete it once
whoever picks this up next has read it and it's stale.

## Update (2026-09-26): module rename decided — brand names locked, code rename not started

Read this before writing marketing copy, README text, illustrations, or
anything else that names a module. The owner locked in a rename to fix
the current grab-bag of module names (a climbing plant, a bird's home, a
loading dock, a generic word, an amusement ride — no shared theme) into a
coherent expedition metaphor:

| Current (code) | Brand name | What it is |
|---|---|---|
| Core | **Terrain** | The ledger of facts everything else is built on |
| Nest (the reference dashboard / `tandem-nest` package, see `packages/nest`) | **Camp** | The operator/admin workspace |
| Ramp | **Ascent** | Agent onboarding and certification |
| Routing | **Waypoint** | Assigning a lead/agent to the right next destination |
| Coaster | **Belay** | The safety layer: disputes, holds, releases, resolution |
| Trail | **Trail** | Unchanged |

**Names that were considered and rejected, and why, so nobody re-proposes
them:** Summit for Core (called out as sounding cringy). Compass for Core
(creates real thematic overlap with Waypoint — both would be navigation
instruments in the same six-word system; Waypoint already owns "which way
next"). Atlas for Core (MongoDB Atlas is one of the most-used
database-as-a-service brands in existence, and Tandem is a database-adjacent
product — this collision actively confuses the exact audience Tandem wants).
Basecamp for Nest (a direct, serious collision with one of the most
recognized SaaS products in the industry — 37signals' Basecamp — not a
borderline case, ruled out without much debate). Bedrock for Core (AWS
Bedrock is a major, current, prominent product in exactly Tandem's
infrastructure space).

**Status: naming decision only, done in README.md and here. Nothing in
code has been renamed.** File names (`ramp.ts`, `coaster.ts`, `routing.ts`),
the `tandem-nest` package name, table names (`tandem.dispute_events`,
`tandem.agent_events`, etc.), and — critically — **event-type strings**
(`dispute.opened`, `onboarding.certified`, etc.) all still use the old
names. That last category is the reason this isn't a quick find-replace
whenever it does happen: event-type strings are literally stored data.
Anyone with a real `tandem.events`/`tandem.dispute_events`/etc. table
already has rows with `event_type = 'dispute.opened'` in them, and this
package's whole design principle is "unknown event types fail replay
instead of silently advancing the sequence" (see README's "What the
package does"). Renaming the stored strings without a real migration path
would make every existing installation's history unreadable. A future
code-level rename needs to either keep the event-type strings as
internal-only naming (rename only the module/file/export names, never the
stored `event_type` values) or ship a real migration that rewrites
existing rows — that's a decision for whoever picks up the code rename,
not a default to assume.

Docs and marketing copy (README, this file, the marketing site, any
illustrations) should use the new brand names starting now. Code stays on
the old names until a deliberate, separate rename pass.

## Update (2026-09-26): product direction correction — this is an embeddable CRM, not just a commission engine

Read this before writing any more copy, README text, or roadmap language.
The owner explicitly corrected the framing this session: **Tandem is meant
to be a real embeddable CRM** — contacts/leads, sales-cycle tracking,
partner-commission handling, and disputes, all as one product — not a
commission engine with a CRM label loosely attached. The package name
(`tandem-crm`) was already right; the shipped product just hadn't caught up
to it yet. This is not scope creep to second-guess; it's the actual target.

**The launch directive, stated explicitly by the owner: "installs like
Payload out of the box."** Not a v2 nice-to-have. The Nest reference
dashboard needs to become a genuinely *installable* admin — something a
host `npm install`s and mounts into their own Next.js app with config, the
way `@payloadcms/next` or `tinacms` work — not a fork-this-example-repo
experience. This is the single highest-priority piece of remaining work and
should be treated as launch-blocking, not deferred.

**Why this doesn't make the engine heavy, and why the admin doesn't have to
either, if built right.** Measured directly this session, real
`npm install` + `du -sh`, not estimates:

| | `node_modules` | packages |
|---|---|---|
| `tandem-crm` engine (all 5 modules + its one dependency, `pg`) | ~1.0 MB | 14 |
| Next.js + React alone (baseline every option below also pays) | 319 MB | 22 |
| Payload (`payload` + `@payloadcms/next` + `@payloadcms/db-postgres` + `@payloadcms/richtext-lexical`) | 752 MB (~433 MB over the Next.js baseline) | 286 |
| TinaCMS (`tinacms` + `@tinacms/cli`) | 969 MB (~650 MB over the Next.js baseline) | 681 — actually *heavier* than Payload, despite Tina's "lightweight, git-backed" reputation; a lot of that is its own local indexing DB (`better-sqlite3`) and CLI tooling |
| Tandem's current reference dashboard, as it exists today | 615 MB (~296 MB over the Next.js baseline) | 494 |

Two conclusions that should drive the architecture from here:
1. **The engine's own code is never the weight problem** — Core alone
   compiles to 16 KB, the other four modules are 4–8 KB each. Splitting a
   `tandem-core`-only package out from the full `tandem-crm` would save
   kilobytes, not megabytes. Don't bother; it's not where the win is.
2. **TinaCMS has an open, unresolved GitHub issue** (tinacms/tinacms#2395,
   also #771) asking for its own admin route to be dynamically loaded so it
   stops leaking ~800–900KB into a host site's production bundle. It hasn't
   solved this. Don't assume "build it like Tina" means the weight problem
   is solved — it isn't, even for Tina. Marketing "the admin is lightweight"
   the way "the engine is lightweight" is claimed would be a promise this
   package can't back up yet either, unless the following is actually done:

**The concrete architecture requirement this implies:** the admin must ship
as a **separate installable package** from the engine (something like
`@tandem-crm/nest` or `tandem-crm/admin`), not bundled into `tandem-crm`
itself, so a host who only wants the engine never pays for chart/data-grid/
drag-and-drop dependencies at all. Within that admin package, routes should
be code-split (Next.js dynamic imports) so unused screens (e.g. a host not
using Coaster) don't ship extra JS to every page. This is a real engineering
project, not a config flag — go into it expecting genuine effort, the same
way Payload and Tina both did.

**Also decided this session, on launch scope for the money-rules gap:**
partial refunds and multiple payments per lead stay explicitly out of scope
for launch — mark it "Coming soon" / "Planned" wherever it's documented
(same honest-roadmap pattern as everything else here), don't build it now.
The business rules genuinely aren't decided yet (see the open-source-gaps
history), and building code against undecided rules is worse than not
building it.

**Two other concrete v1-scope items from this session, not yet started:**
- **A formal `TandemPayoutAdapter`** (mirroring `TandemAuthAdapter`'s
  existing shape), with one reference implementation against Stripe Connect.
  Tandem already never moves money itself — a host always calls
  `commission.paid` after executing their own transfer — but that plug
  point is informal right now. Formalizing it and shipping one real example
  is a credible, moderate-effort launch claim: "plug in Stripe, Tandem
  handles the ledger."
- **Promote sales stage to a first-class lead field**, not something buried
  inside the latest Trail activity entry. Right now there are two different
  pipelines quietly conflated: the commission pipeline (`Automated_Setup` →
  `Won` → `Commission_Paid`, what the Kanban groups by today) and the sales
  pipeline (`New` → `Contacted` → `Qualified` → `Negotiating`, currently only
  visible inside individual Trail entries). A real sales-funnel view needs
  the sales stage queryable on the lead itself.

**Explicitly deferred to post-launch (v2), by the owner's own call, not
mine:** Trail's fuller CRM buildout — tasks/follow-up reminders with due
dates, a deal value distinct from the commission math, and multiple
contacts per lead/account. All real, all wanted, all bigger than a "beef
up" — genuinely new schema and its own event types, deserves its own round
rather than being squeezed into the installable-admin push.

## Update (2026-09-26): Nest configuration path complete

- Workspace setup now includes **commission policy**: an owner/admin can
  configure a product tag, ISO currency, commission rate in basis points, and
  hold period. It is intentionally configuration only: a rule never rewrites
  an existing payout or silently creates money. The host's lead adapter must
  explicitly choose a rule while appending a future commission event.
- In production host-auth mode, setup also offers **Link existing account**.
  It connects an already-verified, host-owned UUID to a selected agent profile
  as an `agent` member. Tandem creates no credentials, invitations, passwords,
  or auth-provider dependency. The dashboard demo hides the form because its
  local identities are intentionally fake.
- The link action is deliberately narrow: owner/admin only, both IDs must be
  UUIDs, the selected profile must be in the current workspace, the account
  cannot already have a membership, and the action cannot grant or overwrite
  owner/admin access. This keeps it an identity mapping step, not a privilege
  escalation mechanism.
- Verified: root typecheck/build, dashboard TypeScript, 89/89 domain tests,
  and all real-Postgres RLS checks pass. The expanded RLS suite proves an
  admin can create commission policy and link an account, while an agent and
  another workspace cannot. The local Workspace setup preview rendered both
  cards and had no browser-console errors.
- Dashboard lint still reports pre-existing errors in imported `reui` example
  components and existing warnings. This slice added none; do not treat it as
  a regression in the Nest configuration workflow.

**Next sensible milestone:** make the generic package install path self-serve:
one documented command path from `DATABASE_URL` through migrations, a health
check, first workspace/admin bootstrap, and a safe sample/empty mode. That is
the remaining "last mile" before a stranger can install the core package
without manual SQL. Hosted database provisioning stays a separate hosted
Tandem CRM concern.

## Update (2026-09-26): Coaster, Core, and Ramp closed for v1

The owner asked for the three near-complete domain modules to be closed in
this order: **Coaster → Core → Ramp**. Each had one real remaining v1 gap;
all three are now closed and tested. Routing and Trail are also closed. The
next work is Nest's production-readiness workflow, not another domain module.

### Nest production-readiness started: agent profiles

- Added an owner/admin-only **Add agent** dashboard flow. It creates the
  operational agent profile and opens it immediately; this is the first
  self-service team-setup capability in Nest.
- It deliberately does **not** create a login account. A host's own auth
  provider remains the authority for credentials and later links its stable
  user id in `tandem.members`, preserving Tandem's bring-your-own-auth model.
- Live local verification added “Demo Operations Agent,” reached its profile,
  and showed no browser-console errors. The permanent CI check proves admins
  can create profiles while agents and other workspaces cannot.
- **Next Nest slice:** owner-managed onboarding-step and territory setup.
  This is higher value than cosmetic dashboard work because it removes the
  remaining manual database configuration from a new workspace's first run.

### Nest workspace setup complete

- Added **Workspace setup** for owners/admins: add onboarding requirements and
  add territories directly from the dashboard. The current list is rendered
  alongside each form so a new workspace's operating configuration is visible.
- Added territory coverage management to each agent profile. A manager can add
  an active territory to the agent, creating the actual candidate pool used by
  automatic routing. The local demo verified a new required step, an East
  Coast territory, and coverage on the newly-created demo agent; browser
  console errors remained empty.
- Expanded the disposable-Postgres suite again: manager-only territory creation
  and coverage assignment, agent denial, and cross-workspace isolation are now
  asserted. All existing 15 migrations and 89 package tests still pass.
- **Next Nest slice:** commission-rule setup and host-auth membership linking.
  Those are the two remaining configuration pieces before a new workspace can
  operate its full lead → commission workflow without direct SQL.

### Coaster checkpoint complete

- The agreed financial rule is now fully represented: an outcome may create a
  typed, auditable financial recommendation, but it never silently moves money;
  an owner/admin confirms any real-world execution.
- Added real database coverage for Coaster's permissions: an assigned agent can
  see their own dispute but cannot append a resolution; a workspace admin can
  append the operator event; an owner in another workspace cannot read it.
- The disposable-Postgres run applied all 13 active migrations and passed the
  scheduler's resolve-and-retry behavior, the new Coaster RLS checks, and the
  existing Core payout/RLS checks. `npm test` remains 87/87 green.
- Coaster is now **v1-complete**. Deliberately excluded from its scope: payment
  execution integrations and unrelated fraud/compliance holds; those are host
  policy/features, not a gap in partner-dispute handling.

### Core checkpoint complete

- Fixed a production RLS gap in the event-plus-projection creation path:
  migration `016_tandem_core_lead_creation.sql` permits a workspace owner/admin
  to insert the first lead projection after a validated `lead.created` fact.
  Previously, the event could be written but the dashboard's New lead action
  could not materialize its projection under `authenticated`.
- The permission is intentionally admin-only. An agent cannot invent an
  unassigned lead or bypass routing; a server-side inbound adapter without a
  human identity continues to use the host's trusted writer.
- Expanded the real-Postgres check to prove admin event+projection creation,
  agent denial for new leads, an agent's permitted own-lead event/projection
  write, and a blocked cross-tenant event append.
- Core is now **v1-complete**: replay/idempotency, integer-money lifecycle,
  migrations, RLS/session handling, and the normal transactional writer path
  all have tested behavior.

### Ramp checkpoint complete

- Added the explicit `onboarding.reopened` event and migration `017`. When a
  workspace adds a required step after an earlier certification, an owner/admin
  can reopen the lifecycle without deleting the original certification history;
  the agent then completes the added step and certifies again.
- The database permits self-service start/step/certify only for an agent's own
  profile. Reopening is admin-only at both the server action and RLS layers.
- The dashboard derives a current certification from both the certification
  event and the *current* required-step set. It shows “Needs review” instead
  of falsely showing “Certified,” and gives a manager the explicit reopen
  control on the agent page.
- Real-Postgres coverage now checks Ramp configuration, own-profile progress,
  cross-workspace isolation, and the agent/admin reopen boundary. The suite is
  **88/88** domain tests plus the full 15-migration RLS run.
- Ramp is now **v1-complete**. It intentionally remains a lightweight
  certification tracker—not an LMS, document store, quiz system, or automatic
  sales/commission gate.

### Routing checkpoint complete

- The pure selector now rejects blank or duplicate candidate IDs in automatic
  modes, preventing an upstream adapter from silently producing ambiguous
  assignments. Manual routing remains intentionally a no-op recommendation.
- Expanded real-Postgres checks prove a member can read the workspace strategy,
  but only an owner/admin can create or change it; another workspace cannot
  read it at all.
- Routing is now **v1-complete**: deterministic strategy selection, sensible
  no-candidate behavior, owner-controlled configuration, and tenant-safe
  database enforcement are all covered. A host still decides when to invoke a
  recommendation and append `lead.assigned`, by design.

### Trail checkpoint complete

- Trail's event/replay/retraction workflow and lead-detail UI were already
  complete. Added the missing real-Postgres permission coverage: an assigned
  agent can append and correct their lead's activity/projection; cross-workspace
  reads and writes are denied.
- Trail is now **v1-complete** as a lightweight CRM activity timeline. It
  deliberately does not expand into contacts, tasks, calendars, or a second
  CRM schema; hosts can layer those on their own database if needed.
- The package's five v1 domain modules—**Core, Ramp, Routing, Coaster, and
  Trail**—are now closed. The full current suite is 89 domain tests and the
  15-migration disposable-Postgres RLS suite.

## Update (2026-09-26): Coaster scheduling + dashboard hardening

Work happened on `codex/coaster-resolution-verification` after the Trail
milestone. Current honest status: Core/Ramp/Routing/Trail are about **85–90%**
of their intended v1 scopes; Coaster is **~90%** after the scheduled-overdue
path below; the Nest reference dashboard is **~84%**; the published,
self-service npm-product experience remains **~65%** because generic init,
release/publish work, and broader deployment docs are deliberately not done.

### Coaster overdue resolution is complete

- Added migration `015_tandem_coaster_overdue_resolution.sql` with
  `tandem.resolve_overdue_disputes()`. A customer's trusted cron/serverless
  scheduler/database scheduler can call it at any cadence. Tandem does not
  install a cron job or choose a platform.
- It locks only due open/queried disputes, appends one idempotent immutable
  `dispute.resolved` fact with outcome `upheld`, and updates the rebuildable
  dispute projection. It deliberately **does not** adjust/reinstate/claw
  back the commission: that stays an explicit host/operator choice.
- Added the exact resolution + retry behavior to the disposable-Postgres CI
  check. A fresh database applied all 13 active migrations and passed the
  scheduler and RLS checks. Manual isolated-Postgres verification also
  confirmed one resolve event/projection update and a no-op second call.

### Dashboard production boundary and regression fixes

- Nest now has a deliberate `TANDEM_AUTH_MODE=host` mode. It disables the
  demo cookie/switcher and uses the one required `lib/host-auth.ts`
  `getHostUserId()` resolver. The file fails closed until a customer replaces
  it with their own verified server-side auth lookup; Tandem adds no auth SDK
  or vendor dependency. The dashboard README documents the four host setup
  steps.
- Added the missing `/agents` roster page. Agent-role users are redirected to
  their own profile rather than seeing a misleading team onboarding roster.
- Fixed a real workspace-context bug throughout dashboard reads and writes:
  RLS appropriately allows an owner to access every workspace they belong to,
  but a dashboard configured for one `TANDEM_WORKSPACE_ID` must still add
  that explicit filter. All dashboard query/action paths now scope to the
  configured workspace. This was exposed by a clean seed test, where an
  owner belongs to multiple demo workspaces.
- Regression: `/`, `/leads`, `/agents`, `/payouts`, `/earnings`, `/disputes`,
  `/settings/routing`, a lead detail, and an agent detail all returned 200
  against a fresh clean seed. The browser rendered the lead Activity surface
  and showed no console errors. A marked, visible local preview remains open
  on the clean dashboard while the local dev server is running.

### AI-ready architecture (implemented foundations, not an AI feature claim)

Tandem is prepared for safe AI-assisted workflows because core business
operations are typed deterministic reducers over append-only, idempotent
events; projections are rebuildable; corrections/retractions preserve audit
history; integer money and RLS constrain sensitive operations; and auth/
database adapters keep provider decisions outside the core package. An AI
agent can therefore be given narrow tools to propose or append validated
facts while every action is attributable and replayable. **Not yet built:**
an MCP/tool API, AI-agent permission policies, model evaluations, or AI
observability. Do not market those as shipped until implemented.

**Next bounded milestone:** generic npm initialization/install experience
(`DATABASE_URL` → migrations → health check → first workspace/admin) and
release hardening. Hosted provider provisioning belongs in the separate
hosted Tandem CRM, not the core package.

## Update (2026-09-26): Trail activity made usable in the reference CRM

Work happened on `codex/coaster-resolution-verification` after Earnings.

- **Lead activity is now a real workflow:** each lead detail page has an
  Activity timeline with a compact `Log activity` form (phone, email, or
  physical interaction; sales stage; confidence; free-text note). This is
  the relationship context a normal CRM needs without introducing a second
  lead/contact/task model into the package.
- **Corrections retain trust:** an agent can correct an activity or retract
  it. Both use Trail's existing immutable event stream and rebuildable
  projection; the UI shows `corrected` and `retracted` rather than silently
  deleting history. Retracted records can no longer be edited or retracted
  again.
- **Kept the package lightweight:** no core API, schema, or dependency was
  added. This is reference-dashboard composition over the existing Trail
  domain layer, actions, migrations, and RLS policies.
- **Verified end-to-end in isolated Postgres:** logged an email interaction,
  corrected its note and confidence, then retracted it. The browser timeline
  showed each resulting state with no console errors. Database verification
  found exactly one each of `trail.visit_logged`, `trail.entry_corrected`,
  and `trail.entry_retracted`; its projection matched the final UI state.
- **Checks:** dashboard TypeScript, root typecheck, and `npm test` (87
  tests) pass. No production build attempt was added because this host's
  Turbopack port-binding restriction is already recorded below.

**Next bounded milestone:** run a short Product Hunt demo-flow pass: a
clean seed, a first-run walkthrough, and an honest readiness checklist. Do
not begin one-click provisioning until this demo flow is coherent.

## Update (2026-09-26): Earnings dashboard completed

Work happened on `codex/coaster-resolution-verification` after the Coaster
resolution milestone.

- **Added `/earnings`:** a member-scoped view of paid commission income with
  week, month, year, and lifetime totals; a six-month paid-commission chart;
  and a searchable, sortable, paginated earnings table. The existing query
  contract intentionally includes only `status = 'paid'` money, so held and
  eligible commissions cannot be presented as income.
- **Added CSV export:** the earnings table generates `tandem-earnings.csv`
  in the browser from the currently filtered paid-commission rows. It does
  not add a server endpoint or transmit data anywhere.
- **Extended the existing payout read model:** `getPayouts()` now exposes
  nullable `paidAt`, allowing the earnings history to show the actual paid
  date while keeping the existing Payouts page compatible.
- **Navigation:** `Earnings` is now available beside Payouts in the Nest
  dashboard sidebar.
- **Verified live:** seeded dashboard data rendered RM 1,200 for the paid
  Delta Cargo commission, correct period totals (RM 1,200 current
  week/month/year and RM 6,000 lifetime), six month labels, and filtering.
  Browser console errors were empty. The browser automation did not report
  completion for a Blob-backed download event, but the enabled export button
  and its client-side path were exercised.
- **Checks:** root typecheck and dashboard-specific TypeScript check pass.
  The dashboard production build remains blocked in this host by the known
  Turbopack worker port-binding restriction. `npm run lint --prefix
  examples/dashboard` also fails on pre-existing reui source lint errors;
  this milestone introduced none.

**Next bounded milestone:** add Trail activity to the Lead detail page, then
run a short Product Hunt demo-flow pass. Do not start installer/provisioning
work until those dashboard surfaces are done.

## Update (2026-09-26): Coaster resolution path verified and fixed

Work happened on `codex/coaster-resolution-verification`, based on
`claude/nest-trail-build`.

- **Verified live against a fresh, isolated Postgres instance:** the Nest
  dashboard loaded with seeded data; an owner resolved an upheld dispute on
  an unpaid commission and applied an amount adjustment; a second upheld
  dispute on a paid commission created a clawback request. The detail page
  displayed the updated payout amount/status and the recorded clawback.
- **Fixed a real projection bug in `examples/dashboard/lib/actions.ts`:**
  `executeDisputeOutcome()` appended its Core event, but the common
  `appendLeadEvent()` writer did not update `tandem.payouts` or append its
  audit-ledger row. The UI could therefore report an action as applied while
  the payout projection kept the old data. The writer now locks and updates
  the payout projection from the reducer result and records the event in
  `tandem.payout_ledger`, in the same transaction.
- **Added outcome idempotency:** the same resolved dispute now has one stable
  `coaster-dispute` source-event key. Retrying the form created neither a
  second Core event nor a second ledger row (confirmed against the database).
  The dashboard also replaces the action form with an explicit “already
  applied” state once that event exists.
- **Checks passed:** root `npm test` (87 tests) and root typecheck. The
  dashboard production build passed after the outcome-writing change; the
  later display-only state change was live-verified in a browser. Subsequent
  build attempts hit the host's Turbopack port-binding restriction, not a
  TypeScript or application error.

### Known demo-tooling follow-up

**Resolved in the next milestone:** `examples/dashboard/scripts/seed.mjs`
now creates a new demo workspace rather than deleting append-only history.
It refuses an existing `TANDEM_WORKSPACE_ID`, prints the new id for the
dashboard environment, and uses fresh tenant-owned ids so multiple demo
workspaces can coexist. Verified: first seed succeeds, repeating the same id
fails safely, and a second new workspace succeeds. The dashboard README now
documents this no-Docker setup.

**Update (this session):** Agent detail page, Leads (list + kanban +
detail), and the `vehicleCount` → `qualificationMetric` genericization
below are all now DONE (see "Where things stand" and the gotchas list,
both updated in place). This PR was merged to `main`. Remaining open
item is Coaster's dispute-execution/clawback layer — see "What Coaster
does not do yet" below, unchanged from last session. DeepSeek was not
used this round: the `DEEPSEEK_API_KEY` in utuh-web's `.env.local` is
being rejected directly by DeepSeek's `/v1/models` endpoint
("Authentication Fails... invalid") — needs rotation before next use.

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
not Radix): Overview, Ramp onboarding, Payouts, Routing settings,
**Agent detail**, and **Leads** (list + kanban + lead detail) pages all
exist now and build/typecheck/lint clean, reading entirely through the
existing `lib/queries.ts` functions (no new queries needed). **Not
browser-verified** — no scripted local dev Postgres exists yet (see the
gotcha below), so these three pages are typecheck/build-clean but
unseen in an actual render. Verify in a real browser before trusting
them blindly.

**Packaging:** `SECURITY.md` and `CONTRIBUTING.md` added, stating the
real RLS/security model including the known gap below. `CHANGELOG.md`
exists (Keep a Changelog format). An automated cross-tenant RLS check
(`scripts/ci-rls-check.mjs`) runs in CI as the `rls` job against a real
Postgres 16 service container.

**Historical note, superseded by the 2026-09-26 closeout above:** the RLS
check now covers Core writes, Ramp, and Coaster. Routing is the remaining
module-specific RLS surface to add before its own v1 closeout.

**Coaster dispute-execution and clawback (DONE, this session):** three new
`domain.ts` event types exist now for a host app to append after reading a
resolved dispute's category/outcome: `commission.adjusted` (unpaid
commission, "incorrect, upheld"), `commission.reinstated` (a `voided`
commission back to `held` with a fresh amount/release date, "untracked" or
"declined, upheld"), and `commission.clawback_requested` (a `paid`
commission, records money owed back without reversing the real payment).
`payment.refunded` on an already-paid commission now clawbacks instead of
refusing the transition. The business-rule decisions this needed (paid
commission → record-obligation-only, not a hard block; untracked/declined
amount → recompute via `calculateCommissionMinor` against the lead's
payment, not a caller-supplied number; execution stays a separate explicit
step, not automatic on `dispute.resolved`) were confirmed with the owner
before writing any of this — see [[tandem-crm-open-source-gaps]] for why
that mattered. The projection/grants decision, dashboard path, scheduler,
and RLS regression coverage were completed in subsequent milestones; see the
current closeout at the top of this file.

**What Coaster still does not do:**

- Tandem intentionally does not install or configure a vendor cron job.
  Migration `015` now provides `tandem.resolve_overdue_disputes()`; the
  customer must grant a reviewed scheduler role permission to call it on a
  cadence appropriate to their deployment.
- Admin-initiated holds unrelated to a partner's own dispute. This is a
  separate fraud/compliance module, not a missing dispute workflow.
- External payment execution. Tandem records an audited adjustment, void,
  reinstatement, or clawback request; a host payment system performs money
  movement only after its own authorized confirmation.

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
- **`vehicleCount` was renamed to `qualificationMetric`** (domain.ts,
  tandem.config.ts, dashboard queries, seed/CI scripts) via migration 012
  (`alter table tandem.leads rename column vehicle_count to
  qualification_metric`), since 001 was already applied wherever this
  schema is installed. If you're updating an existing installation
  (including Utuh's own database, which is a separate copy of this
  schema, not something this repo can migrate for you), you need to run
  012 there too — this repo's migration set does not reach into Utuh's
  live Supabase project. **Gotcha discovered fixing this:** a plain
  `grep` for `vehicleCount`/`vehicle_count` scoped to `.ts`/`.tsx`/`.sql`
  missed two real references in `.mjs` files
  (`scripts/ci-rls-check.mjs`, `examples/dashboard/scripts/seed.mjs`) —
  CI's `rls` job caught it (`column "vehicle_count" of relation "leads"
  does not exist`) on the first push. When renaming an identifier that
  also exists as a DB column name, grep without a file-extension filter.

## Suggested next step

Agent detail, Leads, and the `vehicleCount` rename are done (see
above). The only item left from the original priority list is Coaster's
dispute-execution/clawback layer (security-sensitive, do not hand
straight to DeepSeek — see the note above). Browser-verify the three new
dashboard pages first, since they've only been typecheck/build-verified
so far. Rotate the DeepSeek API key before dispatching to it again.
