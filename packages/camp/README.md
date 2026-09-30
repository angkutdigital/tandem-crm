# tandem-camp

Tandem's installable admin. It mounts a CRM interface into your own Next.js
app: leads with a kanban board, sales activity (Trail), agents, commissions,
earnings, and disputes (Belay). You configure it, the way `@payloadcms/next`
or `tinacms` mount into your app, and you do not fork it.

Every screen from the reference dashboard has moved into this package and been
checked against a real Postgres, including a real Stripe round trip through
the payout adapter. See "Migration status" below for the details.

Full setup instructions are in the
docs: https://tandem-site-84g.pages.dev/guides/camp-admin-ui/

## Quickstart

Install, add one line of CSS, then create two files.

```sh
npm install tandem-camp tandem-crm
```

```css
/* app/globals.css, right after the Tailwind import */
@import "tailwindcss";
@import "tandem-camp/styles.css";
```

Tailwind does not scan `node_modules`, so without that line Camp's screens
render with no layout. The stylesheet also sets default colors that apply only
inside Camp. To change them, set the same variables on `.tandem-camp` after
the import, for example `.tandem-camp { --primary: #2563eb; }`.

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
`[[...segments]]` page, the same shape `@payloadcms/next`'s `RootPage`
uses, not by asking you to create a separate file per screen.

`mountTandemCamp` assumes one long-running Node process (the same
assumption `withTandemSession`'s connection pool already makes), not a
stateless edge function: config is registered once as a module-level
singleton, not re-resolved per request.

## Migration status

Migrated from `examples/dashboard` and live-verified against real
Postgres:

- **Overview** (`views/overview.tsx`, `components/onboarding-checklist.tsx`):
  stat tiles, pipeline breakdown, agent roster for a manager; an agent's
  own onboarding checklist (toggle a step, certify themselves) instead,
  matching the reference dashboard's role split.
- **Leads** (`views/leads.tsx`, `views/lead-detail.tsx`,
  `components/new-lead-dialog.tsx`, `components/trail-activity.tsx`,
  `components/leads-kanban-board.tsx`, `components/reui/kanban.tsx`,
  `components/ui/dialog.tsx`, `components/ui/textarea.tsx`): the
  paginated list and kanban board (rows/cards link to detail), the "New
  lead" dialog (including the PIC/address `attributes` fields), and the
  lead detail page with full Trail activity: CHAMP qualification (log,
  correct, retract), the event history, and the same sales-stage sync a
  trail entry triggers on the lead itself. The kanban board only allows
  dropping into Won/Lost (the two transitions a drag alone has enough
  information for -- see `actions.ts`'s `moveLeadStatus`), same rule the
  dashboard's own board enforces.
- **Payouts** (`views/payouts.tsx`, `actions.ts`): including real
  mutations: Approve (`commission.approved`) and Pay (calls the configured
  `TandemPayoutAdapter`, then `commission.paid`). This is the screen that
  proves the config singleton works for server actions, not just server
  components, verified with a real Stripe API round-trip (a genuine
  `StripeAuthenticationError` from Stripe's own servers), not a mock.
- **Disputes / Belay** (`views/disputes.tsx`, `views/dispute-detail.tsx`,
  `components/dispute-actions.tsx`, `actions.ts`): list, detail, Query,
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
- **Agents** (`views/agents.tsx`, `views/agent-detail.tsx`,
  `components/agent-territory-manager.tsx`, `components/add-agent-dialog.tsx`,
  `actions.ts`): roster (with "Add agent"), detail (onboarding progress,
  territory coverage, assigned leads), and real mutations: adding
  territory coverage and reopening a certification. Live-verified
  including the territory-coverage mutation end to end against real
  Postgres (added coverage, confirmed the row landed via SQL, confirmed
  the "Add coverage" control correctly disappeared once no territories
  were left to add).
  Overview's per-agent branch was live-verified by switching identity to
  a real agent, completing their remaining required step, certifying, and
  confirming `certified_at` landed via SQL.
- **Earnings** (`views/earnings.tsx`, `components/earnings-chart.tsx`) :
  summary totals, a 6-month paid-commission chart, and the paid-payout
  list. Deliberately simpler than examples/dashboard's own
  `EarningsDashboard`, which uses a DataGrid/tanstack-table subsystem and a
  shadcn chart wrapper Camp doesn't carry -- this reuses Camp's existing
  `Table` primitive and `recharts` directly (already a dependency) instead
  of porting that whole subsystem for one screen; no search/sort/CSV
  export yet. Caught a real bug during live verification, not just typecheck:
  the chart was first written directly inside the async Server Component
  view, which fails at runtime (recharts needs a Client Component
  boundary) even though it typechecks and builds cleanly -- moved into its
  own `"use client"` component.
- **Settings** (`views/settings-setup.tsx`, `views/settings-waypoint.tsx`,
  `components/workspace-setup-forms.tsx`, `components/waypoint-strategy-form.tsx`) --
  onboarding requirements, routing territories, commission policy, linking
  a host-authenticated user to an agent profile, and the Waypoint routing
  strategy picker. The dashboard's `isDemoAuth`-only branch on the last
  setup section isn't ported (no Camp equivalent -- a real host always has
  a real auth provider). Live-verified: added a real territory and
  switched the routing strategy, both confirmed via SQL.

**All planned screens are now migrated.** The Leads kanban board
(`components/leads-kanban-board.tsx`, `components/reui/kanban.tsx`) was
the last one: same drag-into-Won/Lost-only rule as the reference
dashboard, live-verified against real Postgres including the same
`flex!`-important-modifier overflow fix this session already shipped for
the dashboard's own board (see CHANGELOG). One caught-but-not-fixed
finding: a `DndDescribedBy-N` `aria-describedby` hydration mismatch shows
up in dev on both this board and the original dashboard's -- confirmed
identical on a fresh tab of the unmodified dashboard route, so it's a
pre-existing `@dnd-kit`/SSR quirk in code that was copied verbatim, not a
regression from this migration. Left as-is; worth a real fix later if it
turns out to matter for production (dev-only overlay, not a production
error boundary trip).

**On delegating a migration to DeepSeek/aider:** three attempts across two
screens have now failed. Agents: the first stalled asking a clarifying
question it couldn't get an answer to in non-interactive mode (fixed in
the retry by including the exact info it needed directly in the prompt);
the second, with that fix applied, got stuck in a degenerate "Writing. /
Let me write. / OK." repetition loop for 65,000+ lines without producing
any real file content, and had to be killed. The New Lead/Add Agent
dialogs: a single well-specified dispatch (full reference file contents
included inline, exactly the fix from the Agents retry) still stalled the
same way: it asked a clarifying question ("please add src/index.ts to
the chat") mid-session, got a good answer, proposed a correct diff, then
asked to be pasted typecheck output before applying anything -- but a
non-interactive `--message-file` session has no one to answer that, so it
ended having written zero files despite having produced a fully correct
plan. Every one of these screens ended up built by hand. Non-interactive
aider dispatch appears to reliably break down the moment a task is large
enough to need even one clarifying round-trip; it may only be worth using
for changes small enough to be answerable in a single shot with zero
back-and-forth.

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
was never going to be the weight problem: Terrain alone compiles to 16 KB.
The weight lives entirely in an admin UI's own dependencies (charts,
drag-and-drop, a data grid, Next.js itself), so that's exactly what has to
stay opt-in. A host who only wants the engine and is building their own UI
must never see any of `tandem-camp`'s dependencies in their lockfile at
all, not hidden behind a subpath export, not behind a feature flag. A
separate published package is the only way to guarantee that.

## Dependency shape

- `tandem-crm` is a normal dependency: this package is a consumer of the
  engine, same as any other host would be.
- `next`, `react`, `react-dom`, and `tailwindcss` are peer dependencies:
  the host supplies these (same convention Payload's own Next.js
  integration uses); this package does not install a second copy of your
  framework.
- Everything else (drag-and-drop, charts, the data grid, UI primitives) is
  this package's own concern, not the host's.
