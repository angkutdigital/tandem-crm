# Tandem CRM

An embeddable, event-sourced partner-attribution and commission-payout engine for Postgres. Install it directly into your own Next.js (or any Node) app. No separate service to run, no vendor lock-in.

**Status:** in production use today, powering a real partner login and commission-tracking flow for [Utuh](https://utuh.com.my), the project this was originally built inside of. RLS-backed multi-tenant isolation is live-tested against real accounts, not just unit tests. The domain package itself is vendor-neutral (see "Adapter pattern" below). The Supabase Auth adapter is proven in production; a generic/BetterAuth adapter for Neon and other plain-Postgres hosts is on the roadmap.

## What the package does

- `domain.ts` qualifies a lead against installation config, defines typed business events, replays one lead from database append order, calculates an exact integer commission, and evaluates the escrow release instant.
- `tandem.config.ts` supplies default qualification and hold settings. An installation may override them. Event payloads must snapshot the qualification result, commission amount/rule outcome, and `releaseAt` so later config edits cannot rewrite history.
- `db/migrations/` drafts a private `tandem` schema with workspaces, agents, territories, agent-territory mapping, commission rules, flexible lead attributes, immutable events, rebuildable lead/payout projections, an append-only payout ledger, and an invoker-rights release function.

The reducer uses `sequence` as the durable ordering key. `occurredAt` is a business timestamp, not a sort key; late-arriving source events still replay in append order. Exact event retries are ignored; conflicting reuse of an event ID or source ID is an error. Unknown event types fail replay instead of silently advancing the sequence. Source event IDs are scoped by workspace and normalized source. A projection writer must validate and append an event and update its projection in one database transaction.

## Serverless deployment contract

The intended host is a thin server-rendered Utuh admin and partner portal backed by PostgreSQL. HTTP/webhook handlers authenticate a request, verify its signature where applicable, normalize provider data into `TandemEvent`, and call a transactional event writer. A trusted database scheduler calls `tandem.release_due_commissions()` on a cadence; it scans due held payouts with row locks and emits `commission.eligible` before changing both lead and payout projections in the same transaction. It does not schedule a job per payout. Eligibility is still distinct from manual approval and actual payment.

Inbound adapters may receive events from any CRM, payment, chat, or manual source. Core code has no Stripe, Tawk, Utuh, or payout-provider dependency. A payout adapter must convert an approved commission to either a recorded manual payout or a verified external payout event; the core never assumes a bank transfer happened.

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

The `tandem-crm/db` entry is separate from the main `tandem-crm` entry on purpose: it pulls in the `pg` driver, while the core engine stays dependency-free and safe to import in edge runtimes.

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

## Ramp: agent onboarding and certification

Ramp tracks whether a sales agent/partner has completed a workspace-defined checklist of onboarding steps and is certified. Scope is deliberately narrow: no content authoring, no LMS, no quizzes, just step tracking and a certification state. Tandem never enforces what certification gates (a territory assignment, a commission rule, anything else); that decision belongs to the implementing application, the same way Core tracks business state without enforcing business policy.

Onboarding events live in their own append-only log, `tandem.agent_events`, rather than `tandem.events`: events there require a `lead_id`, and onboarding events are scoped to an agent, not a lead. `replayAgentOnboardingEvents()` rebuilds one agent's state the same way `replayLeadEvents()` does; `isAgentCertified(state, requiredStepCodes)` checks both `certifiedAt` and that every currently-required step is actually in the completed list, so the answer stays correct even if a workspace adds a new required step after an agent was certified under the old list.

## Lead routing

A workspace can set an auto-assignment preset in `tandem.routing_settings`: `round_robin` (the default; absence of a row means round-robin), `least_loaded`, or `manual` (routing is a no-op, matching what happens today by default). `selectAgentForLead(candidates, strategy, lastAssignedAgentId)` is the pure decision function: the caller queries the eligible agents (already filtered by territory coverage via `tandem.agent_territories`) and their open lead counts, calls this function, then appends the resulting `lead.assigned` event itself. Tandem recommends; it does not assign.

## Open items

- No integration tests against a real database yet (the RLS/portability work in this repo's history was verified by hand against a real disposable Postgres instance, not via an automated CI job; that's still a gap).
- No support for partial refunds, multiple payments per lead, or post-payout clawbacks yet: single full payment / single full refund only.
- The routing decision (`selectAgentForLead`) is a pure function; nothing yet wires it to a real webhook handler that queries eligible agents and appends the resulting event.

## Local verification

From the repository root:

```sh
npm install
npm run typecheck
npm test
npm run build
```

No database credentials or network access are needed for these tests. CI runs the same steps on every push and pull request.
