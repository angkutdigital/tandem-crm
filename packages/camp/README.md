# tandem-camp

Tandem's installable admin. Mounts a CRM interface — leads, agents, sales
activity (Trail), commissions, and disputes (Belay) — into your own Next.js
app, config-driven, the way `@payloadcms/next` or `tinacms` mount into
yours. Not a repo you fork and hack on.

**Status: real, mounted, partially migrated.** The mount contract is
implemented and live-verified against real Postgres (including a real
Stripe API round-trip through the payout adapter) — see "Migration status"
below for exactly which screens have moved from `examples/dashboard` into
this package and which haven't yet.

## Quickstart

```ts
// your-app/tandem-camp.config.ts -- imported for its side effect by every
// Camp route in your app, see the page example below.
import { mountTandemCamp } from "tandem-camp";
import { createTandemPool } from "tandem-crm/db";
import { yourAuthAdapter } from "./your-auth-adapter"; // a TandemAuthAdapter

mountTandemCamp({
  pool: createTandemPool(process.env.DATABASE_URL!),
  workspaceId: process.env.TANDEM_WORKSPACE_ID!,
  authAdapter: yourAuthAdapter,
  // payoutAdapter is optional -- omit it and the Payouts view's "Pay"
  // action throws a clear "not configured" error; everything else still
  // works. See the root README's Adapter pattern (vendor-neutral payouts).
});
```

```tsx
// your-app/app/admin/[[...segments]]/page.tsx -- the one route Camp needs.
import "../../../tandem-camp.config"; // must run before CampRootPage renders
import { CampRootPage } from "tandem-camp";

export default function Page(props: {
  params: Promise<{ segments?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <CampRootPage {...props} basePath="/admin" />;
}
```

That's the whole host wiring: one config module, one catch-all route. Camp
routes internally by the `segments` array Next.js hands a
`[[...segments]]` page — the same shape `@payloadcms/next`'s `RootPage`
uses — not by asking you to create a separate file per screen.

`mountTandemCamp` assumes one long-running Node process (the same
assumption `withTandemSession`'s connection pool already makes), not a
stateless edge function — config is registered once as a module-level
singleton, not re-resolved per request.

## Migration status

Migrated from `examples/dashboard` and live-verified against real
Postgres:

- **Overview** (`views/overview.tsx`) — stat tiles, pipeline breakdown,
  agent roster. Simplified from the reference dashboard: the per-agent
  "your own onboarding checklist" view (shown to a signed-in agent instead
  of a manager) has not moved yet: this pass only migrated the
  owner/admin ("manager") view.
- **Leads** (`views/leads.tsx`) — the paginated list view only. No kanban
  board, no lead detail page, no "New lead" dialog, no Trail activity.
- **Payouts** (`views/payouts.tsx`, `actions.ts`) — including real
  mutations: Approve (`commission.approved`) and Pay (calls the configured
  `TandemPayoutAdapter`, then `commission.paid`). This is the screen that
  proves the config singleton works for server actions, not just server
  components — verified with a real Stripe API round-trip (a genuine
  `StripeAuthenticationError` from Stripe's own servers), not a mock.
- **Disputes / Belay** (`views/disputes.tsx`, `views/dispute-detail.tsx`,
  `components/dispute-actions.tsx`, `actions.ts`) — list, detail, Query,
  Resolve, and Execute Outcome (adjust/reinstate/clawback). The most
  money-adjacent screen migrated so far; ported carefully rather than
  mechanically, and a real bug was caught during live verification, not
  just written and assumed correct: an early version of `appendLeadEvent`
  only synced a payout's `status` column after an event, not
  `amount_minor`/`release_at`/clawback fields, so `commission.adjusted`'s
  new amount silently never reached the `tandem.payouts` projection even
  though the Core event was recorded correctly. Fixed and re-verified with
  a fresh dispute end to end (open → resolve upheld → adjust → confirmed
  the payout's displayed amount actually changed, and that re-applying is
  correctly rejected as already-applied).

**Not yet migrated** (still only in `examples/dashboard`): Agents (roster +
detail + onboarding actions), Earnings, Settings (workspace setup,
Waypoint strategy), lead detail + Trail activity, the Leads kanban board,
the "New lead" dialog, and the per-agent Overview variant named above.
Each of these is a real, separately-verifiable slice of work, not a
formality — migrate and live-verify one at a time, the same way
Overview/Leads/Payouts/Disputes were done, rather than moving several at
once unverified. (An attempt to delegate the Agents migration to a
DeepSeek/aider dispatch stalled asking a clarifying question it couldn't
get an answer to in non-interactive mode, and produced nothing usable —
worth knowing before trying that route again for the remaining screens.)

**Code-splitting:** `root.tsx` dynamically imports each view inside its own
routing branch rather than statically at the top of the file, so visiting
Overview doesn't bundle Leads', Payouts', or Disputes' code.

**Verification harness:** `examples/dashboard/app/tandem-camp/[[...segments]]/page.tsx`
and `examples/dashboard/tandem-camp.config.ts` mount Camp live inside the
reference dashboard app itself, reusing its existing pool/auth/payout
wiring. This is how the above was actually verified against real data, not
a pattern to copy for a real deployment (a real host wouldn't also be
running the parallel, non-Camp dashboard routes at the same time).

## Why this is a separate package, not a subpath of `tandem-crm`

Measured directly (`npm install` + `du -sh`, not estimates): the whole
`tandem-crm` engine plus its one real dependency (`pg`) is about 1 MB. A
realistic Payload install is ~433 MB beyond a bare Next.js app; a realistic
TinaCMS install is ~650 MB beyond the same baseline. The engine's own code
was never going to be the weight problem — Terrain alone compiles to 16 KB.
The weight lives entirely in an admin UI's own dependencies (charts,
drag-and-drop, a data grid, Next.js itself), so that's exactly what has to
stay opt-in. A host who only wants the engine and is building their own UI
must never see any of `tandem-camp`'s dependencies in their lockfile at
all — not hidden behind a subpath export, not behind a feature flag. A
separate published package is the only way to guarantee that.

## Dependency shape

- `tandem-crm` is a normal dependency: this package is a consumer of the
  engine, same as any other host would be.
- `next`, `react`, `react-dom`, and `tailwindcss` are peer dependencies:
  the host supplies these (same convention Payload's own Next.js
  integration uses) — this package does not install a second copy of your
  framework.
- Everything else (drag-and-drop, charts, the data grid, UI primitives) is
  this package's own concern, not the host's.
