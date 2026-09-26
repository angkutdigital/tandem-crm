# Nest reference dashboard

Nest is TandemCRM's reference operator dashboard. It is a Next.js example,
not a separate Tandem service: it reads and writes through the same Postgres
database that hosts the Tandem event log and projections.

## Prerequisites

- Node.js 20 or later
- A Postgres 14+ database that has Tandem's migrations applied
- A dashboard connection role that can assume `authenticated`, as described
  in the repository README's RLS setup section

Build the package first, because this example imports the local package:

```sh
npm install
npm run build
npm install --prefix examples/dashboard
```

## Create demo data

Run the seed script with an elevated connection that can write the event log
and projections:

```sh
cd examples/dashboard
SEED_DATABASE_URL='postgres://...' node scripts/seed.mjs
```

The script prints a new `TANDEM_WORKSPACE_ID`. Copy it into the dashboard's
environment when you start the app:

```sh
DATABASE_URL='postgres://dashboard_role@...' \
TANDEM_WORKSPACE_ID='the-printed-workspace-id' \
npm run dev
```

No Docker container or Tandem-specific worker is required. The seed creates a
new demo workspace each time. It deliberately refuses to overwrite an
existing workspace, because Tandem's event logs are append-only. To make a
fresh demo, run the seed again and use the newly printed workspace id.

The demo identity switcher exists only for this reference app. A production
host keeps its existing sign-in flow and wires one verified server-side
function instead of adding an auth vendor to Tandem:

1. Set `TANDEM_AUTH_MODE=host` in the deployment environment. This disables
   the demo cookie and identity switcher.
2. Replace `lib/host-auth.ts`'s `getHostUserId()` with your current auth
   provider's server-side user-id lookup. Never trust a browser-supplied
   header or query parameter.
3. Ensure that stable user id is present in `tandem.members.user_id` for the
   selected `TANDEM_WORKSPACE_ID`. The package's `TandemAdminAdapter` is the
   portable membership-provisioning contract.
4. Keep your own provider's route protection/middleware. Nest deliberately
   does not ship Clerk, Supabase Auth, Auth0, or another identity SDK.

The default (no `TANDEM_AUTH_MODE`) remains the seed-data demo mode. Host
mode fails closed until the resolver is wired, preventing a deployment from
silently running as the demo owner.
