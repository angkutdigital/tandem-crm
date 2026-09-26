# Tandem CRM

An embeddable, event-sourced CRM engine for Postgres: leads, agents, sales-cycle activity, partner commissions, and dispute handling, all as typed append-only facts. Install it directly into your own Next.js (or any Node) app. No separate service to run, no vendor lock-in.

**What "embeddable" means in practice:** `tandem-crm` (this package) is the engine — five modules (Terrain, Ascent, Waypoint, Belay, Trail), one runtime dependency (`pg`), no UI. A separate, installable admin package, `tandem-camp` (in progress — see [Where this is going](#where-this-is-going)), is meant to mount a real CRM interface into your own Next.js app the way `@payloadcms/next` or `tinacms` do, rather than handing you an example repo to fork. Today, `examples/dashboard` is that reference example; it is not yet the installable package.

**Status:** in production use today, powering a real partner login and commission-tracking flow for the project this was originally built inside of. RLS-backed multi-tenant isolation is live-tested against real accounts, not just unit tests. The domain package itself is vendor-neutral (see "Adapter pattern" below). The Supabase Auth adapter is proven in production; identity resolution and RLS are also verified against a plain, non-Supabase Postgres 16 instance, so implementing `TandemAuthAdapter` against Neon, RDS, Clerk, BetterAuth, or your own session table needs no changes to the package itself. See [CHANGELOG.md](./CHANGELOG.md) for what shipped when.

## Terrain: what the package does

- `domain.ts` qualifies a lead against installation config, defines typed business events, replays one lead from database append order, calculates an exact integer commission, and evaluates the escrow release instant.
- `tandem.config.ts` supplies default qualification and hold settings. An installation may override them. Event payloads must snapshot the qualification result, commission amount/rule outcome, and `releaseAt` so later config edits cannot rewrite history.
- `db/migrations/` drafts a private `tandem` schema with workspaces, agents, territories, agent-territory mapping, commission rules, flexible lead attributes, immutable events, rebuildable lead/payout projections, an append-only payout ledger, and an invoker-rights release function.

The reducer uses `sequence` as the durable ordering key. `occurredAt` is a business timestamp, not a sort key; late-arriving source events still replay in append order. Exact event retries are ignored; conflicting reuse of an event ID or source ID is an error. Unknown event types fail replay instead of silently advancing the sequence. Source event IDs are scoped by workspace and normalized source. A projection writer must validate and append an event and update its projection in one database transaction.

## Serverless deployment contract

The intended host is a thin server-rendered admin and partner portal backed by PostgreSQL. HTTP/webhook handlers authenticate a request, verify its signature where applicable, normalize provider data into `TandemEvent`, and call a transactional event writer. A trusted database scheduler calls `tandem.release_due_commissions()` on a cadence; it scans due held payouts with row locks and emits `commission.eligible` before changing both lead and payout projections in the same transaction. It does not schedule a job per payout. Eligibility is still distinct from manual approval and actual payment.

Inbound adapters may receive events from any CRM, payment, chat, or manual source. Terrain's own code has no Stripe, Tawk, or payout-provider dependency. A payout adapter must convert an approved commission to either a recorded manual payout or a verified external payout event; Terrain never assumes a bank transfer happened.

Agents, territories, mappings, commission rules, and workspace settings are mutable configuration. Lead creation, assignment, conversion, payment, refund, and commission transitions are immutable business facts. Flexible lead attributes belong in the lead projection; only business-significant changes should become typed events. The current reducer models one commission hold per lead and full refunds before payout. Partial refunds, multiple payments, and post-payout clawbacks require additional event types before production use.

## Database setup

Tandem ships its schema as SQL files in `db/migrations/` and a runner that applies them. Run it on deploy or at startup; it only applies what's new, so repeat runs are safe.

```ts
import { createTandemPool, applyTandemMigrations } from "tandem-crm/db";

const pool = createTandemPool(process.env.DATABASE_URL!);
const { applied } = await applyTandemMigrations(pool);
```

Each file runs in its own transaction, so a failed migration rolls back completely instead of leaving a half-built schema. Applied files are recorded in `tandem.schema_migrations`.

Per-request queries go through `withTandemSession`, which tells the row-level security policies who the caller is:

```ts
import { withTandemSession } from "tandem-crm/db";

const leads = await withTandemSession(pool, currentUserId, (client) =>
  client.query("select * from tandem.leads")
);
```

**One-time setup this requires:** `withTandemSession` assumes the `authenticated` role for the duration of the transaction, unconditionally. This matters because RLS is bypassed entirely for a table's owner and for a superuser, and the role a hosted Postgres (Neon, RDS, a fresh Supabase project) hands you by default is almost always exactly the role that owns everything it creates. Grant the role your connection string actually uses membership in `authenticated` once:

```sql
grant authenticated to your_connection_role;
```

Skipping this doesn't silently do nothing: `set local role authenticated` fails loudly with a permission error rather than quietly running unenforced.

The `tandem-crm/db` entry is separate from the main `tandem-crm` entry on purpose: it pulls in the `pg` driver, while Terrain stays dependency-free and safe to import in edge runtimes.

### Upgrading a hand-migrated database

If the `tandem` schema was created by running the SQL files by hand (before the runner existed), the runner refuses to touch it rather than guess what's already there. Record the files that database already has, once, then run the runner as normal:

```sql
create table tandem.schema_migrations (filename text primary key, applied_at timestamptz not null default now());
insert into tandem.schema_migrations (filename) values
  ('001_tandem_core.sql'), ('002_tandem_events.sql'), ('003_tandem_payouts.sql'),
  ('004_release_due_commissions.sql'), ('005_tandem_auth_rls.sql'), ('006_tandem_grants.sql');
```

List only the files that were actually applied. The runner then applies everything after them.

## Security and migration status

The `tandem` schema is applied to production and exposed to PostgREST. Row-level security is active: workspace membership rows in `tandem.members` gate access, and the leads view is scoped by RLS (agents see their own leads, owners/admins see all). The schema's release function uses caller privileges and grants no public execution. A service-role key must stay server-side and cannot substitute for tested browser authorization.

The migration set does **not** create Auth identities, webhook secrets, or a cron schedule. Those belong in a separately reviewed migration after the correct Supabase project and client credentials are verified. Limit retention/access for `raw_payload` because it can contain personal data. Do not expose the private schema to client code beyond the intended PostgREST surface.

**Host portability:** `005`/`006` were written against Supabase-only assumptions (`auth.users`, `auth.uid()`, the `authenticated` role) that silently broke every non-Supabase host. `007_tandem_portable_auth.sql` fixes all three: identity now resolves through `tandem.current_user_id()`, which reads a `tandem.user_id` session setting (see `src/db/client.ts`'s `withTandemSession`) and falls back to `auth.uid()` only where Supabase provides it. Verified by actually running the full migration set against a fresh, non-Supabase Postgres 16 instance and confirming cross-tenant row-level isolation holds for real seeded data (two workspaces, two users, explicit cross-tenant reads returning zero rows), not just a read of the policy SQL.

## Adapter pattern (vendor-neutral auth)

`auth.ts` does not import any vendor SDK. It takes a `TandemAuthAdapter` (see `authAdapter.ts`) as its first argument:

```typescript
export type TandemAuthAdapter = {
  getCurrentUserId(): Promise<string | null>;
  getMember(workspaceId: string, userId: string): Promise<TandemMemberRow | null>;
  getAnyMember(userId: string): Promise<TandemMemberRow | null>;
};
```

The Supabase implementation lives outside the package at `src/lib/supabase/tandemSupabaseAdapter.ts` and is passed in by callers (e.g. `getCurrentTandemMember(tandemSupabaseAdapter, workspaceId)`). To plug in a non-Supabase backend, implement `TandemAuthAdapter` against that backend and pass it to the same functions. No changes to the package are required.

## Setup verification (`doctor.ts`)

`runTandemDoctor(supabaseUrl, supabaseKey)` makes plain `fetch` calls (no SDK) against a live project and reports whether the `tandem` schema is exposed to PostgREST and whether a public key is correctly denied direct access. It is meant to be run standalone against an installation from the outside. It is not yet wired into a CLI or `package.json` script; that is a follow-up.

## Agent provisioning

`TandemAdminAdapter.createMembership(workspaceId, userId, role, agentId)` creates the membership row linking an already-existing auth user to a workspace. It does **not** create the auth user itself: the caller must first create the user via the host auth provider (e.g. Supabase Auth's `inviteUserByEmail`) and pass the resulting `userId` in. The Supabase implementation runs with the calling user's own session, so it only succeeds if that user is already an owner/admin per the RLS policy on `tandem.members`.

## Ascent: agent onboarding and certification

Ascent tracks whether a sales agent/partner has completed a workspace-defined checklist of onboarding steps and is certified. Scope is deliberately narrow: no content authoring, no LMS, no quizzes, just step tracking and a certification state. Tandem never enforces what certification gates (a territory assignment, a commission rule, anything else); that decision belongs to the implementing application, the same way Terrain tracks business state without enforcing business policy.

Onboarding events live in their own append-only log, `tandem.agent_events`, rather than `tandem.events`: events there require a `lead_id`, and onboarding events are scoped to an agent, not a lead. `replayAgentOnboardingEvents()` rebuilds one agent's state the same way `replayLeadEvents()` does; `isAgentCertified(state, requiredStepCodes)` checks both `certifiedAt` and that every currently-required step is actually in the completed list, so the answer stays correct even if a workspace adds a new required step after an agent was certified under the old list. In that case an owner/admin appends `onboarding.reopened`; it preserves the earlier certification fact, lets the agent complete the new requirement, and permits a fresh certification without deleting audit history.

## Waypoint: lead routing

A workspace can set an auto-assignment preset in `tandem.waypoint_settings`: `round_robin` (the default; absence of a row means round-robin), `least_loaded`, or `manual` (assignment is a no-op, matching what happens today by default). `selectAgentForLead(candidates, strategy, lastAssignedAgentId)` is the pure decision function: the caller queries the eligible agents (already filtered by territory coverage via `tandem.agent_territories`) and their open lead counts, calls this function, then appends the resulting `lead.assigned` event itself. Waypoint recommends; it does not assign.

## Belay: disputes on a commission

Belay tracks a partner-initiated dispute against a commission that's already held, eligible, or approved, and an operator's resolution of it. Partners can open a dispute; only a workspace owner or admin can resolve one, enforced by the database's own row-level security, not just application convention. Three categories, matching how Awin (the largest affiliate network in Europe) models this: `untracked` ("this sale never showed up"), `incorrect` (the amount is wrong; carries an `expectedAmountMinor`), and `declined` ("this should have been approved"). An operator can also ask a question (`dispute.queried`) before resolving.

Dispute events live in their own append-only log, `tandem.dispute_events`, for the same reason Ascent's do: they don't fit `tandem.events`' existing shape. `replayDisputeEvents()` rebuilds one dispute's state; `disputeAutoApproveAt(openedAt, autoApproveDays)` computes and snapshots a deadline at open time (Awin's own default is 75 days, but this package does not hardcode it, the caller decides); `isDisputeOverdue(state, now)` is a pure check for callers that want a preview. For production, a trusted scheduler can call `tandem.resolve_overdue_disputes()` on a cadence: it locks due open/queried disputes, appends one idempotent `dispute.resolved` fact with an upheld outcome, and updates the rebuildable dispute projection. Tandem does not install a cron job or select a vendor; a host grants a reviewed scheduler role explicit execute permission. Like Terrain's `commission.held`, resolving a dispute only records the outcome (`upheld` or `dismissed`); Belay does not itself create a replacement commission, adjust an amount, or claw back money already paid. That execution remains a separate, explicit host/operator decision.

The one place Belay changes Terrain's own behavior: `release_due_commissions()` now skips a payout with an open or queried dispute, even past its release date. Everywhere else, Belay only reads Terrain's leads and payouts.

Executing an upheld dispute's outcome is a separate, explicit step from resolving it: three Terrain event types exist for a host to append after reading a resolved dispute's category and outcome — `commission.adjusted` (correct an unpaid commission's amount), `commission.reinstated` (bring a `voided` commission back to `held` with a fresh amount/release date), and `commission.clawback_requested` (record money owed back on an already-paid commission, without Tandem reversing the payment itself — it never touches money). Belay still never appends these on its own; the host decides.

## Trail: lightweight sales activity

Trail is a per-lead activity log — the minimum a sales cycle actually needs, kept deliberately free-text-first rather than a full CRM object model. An agent logs a visit report (`phone`, `physical`, or `email`), a 1–10 confidence rating, a sales stage, and a note; entries can be corrected or retracted without deleting history (both show as `corrected`/`retracted`, never silently gone).

Trail events live in their own append-only log, `tandem.trail_events`, projected into `tandem.trail_entries`, same pattern as Ascent and Belay. `replayTrailEntries()` folds a lead's whole activity stream into one entry per id, oldest first. Tandem never reads or acts on Trail data itself; it's purely something an agent records and an owner/admin reviews.

**Known scope gap, on purpose, deferred to a later release:** sales stage currently lives on the Trail entry, not as a queryable field on the lead itself, which means it's conflated with the commission pipeline (`Automated_Setup` → `Won` → `Commission_Paid`) for anything that groups leads by status today (e.g. the reference dashboard's kanban board). A real sales-funnel view needs sales stage promoted to a first-class lead field. Also deliberately out of scope for now: tasks/follow-up reminders, a deal value distinct from commission math, and multiple contacts per lead — real CRM features, each larger than a Trail tweak, planned for their own release rather than squeezed in here.

## Where this is going

Tandem's target shape is a real embeddable CRM: leads, agents, sales-cycle activity, partner commissions, and disputes as one product, installed the way Payload or Tina install — not a commission engine with a CRM label loosely attached. Concretely, still ahead:

- **Camp, the installable admin package** (`tandem-camp` in code), separate from the engine, mounted into a host's own Next.js app with config rather than forked as example code. Kept as a separate package deliberately: a host who only wants the engine should never pay for the admin's chart/data-grid/drag-and-drop dependencies. Measured directly (real `npm install` + `du -sh`, not estimates): the whole `tandem-crm` engine plus its one dependency (`pg`) is about 1 MB; a realistic Payload install is ~433 MB beyond a bare Next.js app, and a realistic Tina install is ~650 MB beyond the same baseline. The engine was never going to be the weight problem — keeping Camp that light is the actual engineering goal, and neither Payload nor Tina has fully solved it either (Tina's own admin-bundle-size issue is still open upstream).
- **A formal payout adapter**, mirroring `TandemAuthAdapter`'s shape, with a reference implementation against Stripe Connect. Tandem already never moves money itself; this makes that plug point a documented interface instead of an implicit convention.
- **Sales stage as a first-class lead field**, not buried inside a Trail entry (see the Trail section above).

## Open items

- The CI RLS check (`scripts/ci-rls-check.mjs`, runs on every push/PR) covers Terrain read/write boundaries, Ascent's template/progress/recertification boundary, Waypoint configuration, Belay dispute visibility/resolution, and Trail activity writes. It uses a disposable real Postgres database, not mocks.
- No support for partial refunds or multiple payments per lead yet: single full payment / single full refund only. Deliberately deferred — the business rules aren't decided yet, not just unbuilt.
- Belay can execute an upheld dispute's outcome (see above), but has no scheduled auto-execution and no admin-initiated holds unrelated to a partner dispute (fraud/compliance review).
- The routing decision (`selectAgentForLead`) is a pure function; nothing yet wires it to a real webhook handler that queries eligible agents and appends the resulting event.
- Camp, the Stripe payout adapter, and sales-stage-as-a-lead-field are not started — see "Where this is going" above.

## Local verification

From the repository root:

```sh
npm install
npm run typecheck
npm test
npm run build
```

No database credentials or network access are needed for these tests. CI runs the same steps on every push and pull request.

CI also runs `scripts/ci-rls-check.mjs` against a real, disposable Postgres service container: applies every migration, seeds two workspaces, and asserts cross-tenant isolation actually holds (a member sees only their own workspace's rows, a query with no identity set sees nothing, not everything). To run it yourself against a local Postgres:

```sh
npm run build
DATABASE_URL=postgres://user:pass@localhost:5432/some_throwaway_db node scripts/ci-rls-check.mjs
```

Point it at a database you don't mind seeding test data into; the script does not clean up after itself.
